import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getAuthToken } from '../auth/keycloak'
import { S3Config } from '../components/home'

export async function fetchDocumentTypes(documentType: string) {
    try {
        const response = await fetch(
            `http://localhost:5000/api/documents/types`,
        )
        if (!response.ok) {
            throw new Error('Failed to fetch document types.')
        }
        const typeData = await response.json()
        console.log(typeData)
        const documentTypeObject = typeData.data.find(
            (type: { name: string }) =>
                type.name.toLowerCase() === documentType,
        )
        if (documentTypeObject) {
            return documentTypeObject.id
        } else {
            console.error(`Error: ${documentType} not found.`)
        }
    } catch (error) {
        console.error('Error fetching document types:', error)
    }
}

export async function uploadImageToS3AndCreateDocument({
    file,
    userId,
    organizationId,
    documentType,
}: {
    file: File | Blob
    userId: string
    organizationId: string
    documentType: string
}) {
    if (!file) throw new Error('No file provided')

    // retrieve document type id from vapor-flow
    const documentTypeId = await fetchDocumentTypes(documentType)

    if (
        !process.env.REACT_APP_AWS_S3_BUCKET_USER_KEY ||
        !process.env.REACT_APP_AWS_S3_BUCKET_USER_SECRET
    ) {
        throw new Error('Missing AWS S3 credentials in environment variables')
    }

    // upload the file to S3
    const s3Client = new S3Client({
        region: process.env.REACT_APP_AWS_REGION,
        credentials: {
            accessKeyId: process.env.REACT_APP_AWS_S3_BUCKET_USER_KEY,
            secretAccessKey: process.env.REACT_APP_AWS_S3_BUCKET_USER_SECRET,
        },
    })

    const sanitizedFileName =
        file instanceof File
            ? file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
            : `upload_${Date.now()}`

    const s3Key = `quality-install/photos/${Date.now()}_${sanitizedFileName}`

    const putObjectCommand = new PutObjectCommand({
        Bucket: process.env.REACT_APP_AWS_S3_BUCKET,
        Key: s3Key,
        Body: new Uint8Array(await file.arrayBuffer()),
        ContentType: sanitizedFileName.toLowerCase().endsWith('pdf')
            ? 'application/pdf'
            : sanitizedFileName.toLowerCase().endsWith('svg')
              ? 'image/svg+xml'
              : 'image/jpeg',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: process.env.REACT_APP_AWS_S3_KMS_KEY_ID,
    })

    await s3Client.send(putObjectCommand)

    const s3Path = `s3://${process.env.REACT_APP_AWS_S3_BUCKET}/${s3Key}`

    // create a document in vapor-core
    const documentResponse = await fetch(
        `http://localhost:5000/api/documents/create`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${getAuthToken()}`,
            },
            body: JSON.stringify({
                user_id: userId,
                document_type_id: documentTypeId,
                file_path: s3Path,
                organization_id: organizationId,
                expiration_date: null,
                comments: `Uploaded photo from QIT: ${sanitizedFileName}`,
            }),
        },
    )

    if (!documentResponse.ok) {
        throw new Error('Failed to create document in vapor-core')
    }

    const documentData = await documentResponse.json()

    const documentId = documentData?.data?.id

    if (!documentId) {
        throw new Error('Document ID missing in vapor-core response')
    }

    // return the new documentId
    return documentId
}
