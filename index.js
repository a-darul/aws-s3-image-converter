const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const sharp = require('sharp');

const s3Client = new S3Client({
	region: process.env.AWS_S3_REGION,
	credentials: {
		accessKeyId: process.env.AWS_ACCESS_KEY_ID,
		secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
	},
});

const BUCKET = process.env.AWS_BUCKET_NAME;
const BATCH_SIZE = process.env.BATCH_SIZE || 20;
const SLEEP_INTERVAL = 100;

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function generateMissingJpgFiles() {
	try {
		// List all objects in the spots directory
		const listCommand = new ListObjectsV2Command({
			Bucket: BUCKET,
			Prefix: "spots/manual-",
			...(process.env.NEXT_CONTINUATION_TOKEN && { ContinuationToken: process.env.NEXT_CONTINUATION_TOKEN }),
		});

		const { Contents = [], IsTruncated, NextContinuationToken } = await s3Client.send(listCommand);

		console.log(`Found ${Contents.length} files`);

		// Filter and group files by base name
		const fileGroups = Contents.reduce((acc, { Key }) => {
			if (!Key.endsWith('.webp')) return acc;

			const baseName = Key.slice(0, -5);
			const jpgKey = `${baseName}.jpg`;

			if (!acc[baseName]) {
				acc[baseName] = {
					webpKey: Key,
					jpgKey,
					hasJpg: false
				};
			}

			return acc;
		}, {});

		// Mark which ones already have JPG versions
		Contents.forEach(({ Key }) => {
			if (Key.endsWith('.jpg')) {
				const baseName = Key.slice(0, -4);
				if (fileGroups[baseName]) {
					fileGroups[baseName].hasJpg = true;
				}
			}
		});

		const needJPGFiles = Object.values(fileGroups).filter(({ hasJpg }) => !hasJpg);

		console.log(`${needJPGFiles.length} files need JPG versions`);

		// Process files in batches with parallel processing within each batch
		for (let i = 0; i < needJPGFiles.length; i += BATCH_SIZE) {
			const batch = needJPGFiles.slice(i, i + BATCH_SIZE);

			console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}`);

			// Process batch sequentially but with parallel file conversion
			await Promise.all(batch.map(async ({ webpKey, jpgKey }) => {
				try {
					console.log(`Generating JPG for ${webpKey}`);

					// Get the webp file
					const getCommand = new GetObjectCommand({
						Bucket: BUCKET,
						Key: webpKey
					});

					const { Body } = await s3Client.send(getCommand);
					const buffer = await streamToBuffer(Body);

					// Convert to JPG
					const jpgBuffer = await sharp(buffer)
						.jpeg()
						.toBuffer();

					// Upload JPG version
					const putCommand = new PutObjectCommand({
						Bucket: BUCKET,
						Key: jpgKey,
						Body: jpgBuffer,
						ContentType: 'image/jpeg',
						ACL: 'public-read'
					});

					await s3Client.send(putCommand);

					console.log(`Generated JPG: ${jpgKey}\n`);
				} catch (error) {
					console.error(`Error processing ${webpKey}:`, error);
				}
			}));

			// Optional: Add a small delay between batches to prevent overwhelming the system
			await sleep(SLEEP_INTERVAL);
		}

		if (IsTruncated) {
			console.warn('Warning: S3 list is truncated. Some files may be missing.');
			console.warn('NextContinuationToken:', NextContinuationToken);
		}

	} catch (error) {
		console.error('Error processing files:', error);
		throw error;
	}
}

// Utility function to convert stream to buffer
async function streamToBuffer(stream) {
	const chunks = [];
	for await (const chunk of stream) {
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

generateMissingJpgFiles();