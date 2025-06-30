import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
} from '@aws-sdk/client-s3'
import { getConfig } from '../config'
import { getMetadataFromPhoto } from './photo_utils'

const REACT_APP_VAPORCORE_URL = getConfig('REACT_APP_VAPORCORE_URL')
const REACT_APP_AWS_S3_BUCKET_USER_KEY = getConfig(
    'REACT_APP_AWS_S3_BUCKET_USER_KEY',
)
const REACT_APP_AWS_S3_BUCKET_USER_SECRET = getConfig(
    'REACT_APP_AWS_S3_BUCKET_USER_SECRET',
)
const REACT_APP_AWS_REGION = getConfig('REACT_APP_AWS_REGION')
const REACT_APP_AWS_S3_BUCKET = getConfig('REACT_APP_AWS_S3_BUCKET')
const REACT_APP_AWS_S3_KMS_KEY_ID = getConfig('REACT_APP_AWS_S3_KMS_KEY_ID')

export async function fetchDocumentTypes(documentType: string) {
    try {
        const response = await fetch(
            `${REACT_APP_VAPORCORE_URL}/api/documents/types`,
        )
        if (!response.ok) {
            throw new Error('Failed to fetch document types.')
        }
        const typeData = await response.json()
        const documentTypeObject = typeData.data.find(
            (type: { name: string }) =>
                type.name.toLowerCase() === documentType.toLowerCase(),
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
    applicationId,
    documentType,
    measureName,
}: {
    file: File | Blob
    userId: string | null
    organizationId: string | null
    applicationId: string | null
    documentType: string
    measureName: string
}) {
    if (!file) throw new Error('No file provided')

    // retrieve document type id from vapor-flow
    const documentTypeId = await fetchDocumentTypes(documentType)

    if (
        !REACT_APP_AWS_S3_BUCKET_USER_KEY ||
        !REACT_APP_AWS_S3_BUCKET_USER_SECRET
    ) {
        throw new Error('Missing AWS S3 credentials in environment variables')
    }

    // upload the file to S3
    const s3Client = new S3Client({
        region: REACT_APP_AWS_REGION,
        credentials: {
            accessKeyId: REACT_APP_AWS_S3_BUCKET_USER_KEY,
            secretAccessKey: REACT_APP_AWS_S3_BUCKET_USER_SECRET,
        },
    })

    // normalize & convert measure name to kebab-case
    const sanitizedMeasureName = measureName.toLowerCase().replace(/\s+/g, '-')

    const fileName = `${Date.now()}_${applicationId}_${sanitizedMeasureName}`

    const s3Key = `quality-install/documents/${sanitizedMeasureName}/${fileName}.pdf`

    const putObjectCommand = new PutObjectCommand({
        Bucket: REACT_APP_AWS_S3_BUCKET,
        Key: s3Key,
        Body: new Uint8Array(await file.arrayBuffer()),
        ContentType: 'application/pdf',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: REACT_APP_AWS_S3_KMS_KEY_ID,
    })

    await s3Client.send(putObjectCommand)

    const s3Path = `s3://${REACT_APP_AWS_S3_BUCKET}/${s3Key}`

    // create a document in vapor-core
    const documentResponse = await fetch(
        `${REACT_APP_VAPORCORE_URL}/api/documents/create`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                user_id: userId,
                document_type_id: documentTypeId,
                file_path: s3Path,
                organization_id: organizationId,
                application: {}, // application object needed for document API call to succeed
                application_id: applicationId,
                expiration_date: null,
                comments: `Uploaded photo from QIT: ${fileName}`,
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

export const handleFetchFileFromS3 = async (
    fileIndex: number,
    fileData: any,
    s3Client: any,
    setFileUrl: any,
) => {
    if (!fileData || fileData.length === 0) {
        alert('No file available to retrieve')
        return
    }

    const fileInfo = fileData[fileIndex]

    const params = {
        Bucket: fileInfo.bucket,
        Key: fileInfo.key,
    }

    try {
        const response = await s3Client.send(new GetObjectCommand(params))

        if (!response.Body) {
            throw new Error('No file data found in S3 response')
        }

        const { Body } = response

        const detectedContentType = fileInfo.name
            ?.toLowerCase()
            .endsWith('.pdf')
            ? 'application/pdf'
            : fileInfo.name?.toLowerCase().endsWith('.svg')
              ? 'image/svg+xml'
              : fileInfo.name?.endsWith('.xml')
                ? 'application/xml'
                : 'application/octet-stream'

        // convert readablestream to blob
        const blob = await streamToBlob(Body, detectedContentType)

        if (detectedContentType === 'application/xml') {
            // for xml, set the url for download instead of preview
            const objectUrl = URL.createObjectURL(blob)
            setFileUrl(objectUrl)
            // if svg, render as text vs data url
        } else if (detectedContentType === 'image/svg+xml') {
            const svgBlob = new Blob([await blob.text()], {
                type: 'image/svg+xml',
            })
            const objectUrl = URL.createObjectURL(svgBlob)
            setFileUrl(objectUrl)
        } else {
            const objectUrl = URL.createObjectURL(blob)
            setFileUrl(objectUrl)
        }
    } catch (error) {
        console.error('Error retrieving file from S3:', error)
        alert('Failed to retrieve file from S3')
    }
}

// Helper function to convert ReadableStream to Blob
// can remove when variable logic is fixed for presigned URLs
export const streamToBlob = async (
    stream: any,
    contentType: string,
): Promise<Blob> => {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let done = false

    while (!done) {
        const { value, done: readerDone } = await reader.read()
        if (value) {
            chunks.push(value)
        }
        done = readerDone
    }

    return new Blob(chunks, { type: contentType })
}

// extension map to standardize ContentType across uploads
export const extensionMap: Record<string, string> = {
    pdf: 'application/pdf',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
}

// helper function to parse bucket/key/fileName from s3 path
export const parseS3Path = (s3Path: string, bucketName?: string) => {
    // if s3Path is already just a key, assume the bucketName is provided
    if (!s3Path.startsWith('s3://')) {
        if (!bucketName) {
            console.error(
                'Bucket name is required for relative S3 paths:',
                s3Path,
            )
            return null
        }
        return {
            bucket: bucketName,
            key: s3Path,
            fileName: s3Path.split('/').pop() || 'Unknown File',
        }
    }
    const match = s3Path.match(/^s3:\/\/([^\/]+)\/(.+)$/)
    if (!match) {
        console.error('Invalid S3 path:', s3Path)
        return null
    }
    const bucket = bucketName ? bucketName : match[1]
    const key = match[2]
    const fileName = key.split('/').pop() || 'Unknown File'

    return { bucket, key, fileName }
}

export async function fetchDocumentById(documentId: string) {
    const response = await fetch(
        `${REACT_APP_VAPORCORE_URL}/api/documents/${documentId}`,
    )

    if (!response.ok) {
        throw new Error('Failed to fetch document metadata')
    }

    const json = await response.json()
    return json.data
}

// export async function hydratePhotoFromDocumentId({
//     documentId,
//     entryId,
//     attachmentId,
//     upsertAttachment,
// }: {
//     documentId: string
//     entryId: string
//     attachmentId: string
//     upsertAttachment: (
//         blob: Blob,
//         id: string,
//         docId?: string,
//         metadata?: any,
//     ) => void
// }) {
//     const s3Client = new S3Client({
//         region: REACT_APP_AWS_REGION,
//         credentials: {
//             accessKeyId: REACT_APP_AWS_S3_BUCKET_USER_KEY,
//             secretAccessKey: REACT_APP_AWS_S3_BUCKET_USER_SECRET,
//         },
//     })
//     try {
//         const doc = await fetchDocumentById(documentId)
//         const { bucket, key, fileName } = parseS3Path(doc.file_path)!
//         const command = new GetObjectCommand({ Bucket: bucket, Key: key })
//         const response = await s3Client.send(command)

//         const contentType =
//             fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')
//                 ? 'image/jpeg'
//                 : fileName.endsWith('.png')
//                   ? 'image/png'
//                   : 'application/octet-stream'

//         const blob = await streamToBlob(response.Body, contentType)
//         console.log(blob)

//         const metadata = await getMetadataFromPhoto(blob)

//         // Inject into PouchDB/StoreContext
//         upsertAttachment(blob, entryId, entryId, metadata)
//         console.log(`[Hydration] Injected ${attachmentId} into attachments`)
//     } catch (err) {
//         console.error('Failed to hydrate building number photo:', err)
//     }
// }

export async function hydratePhotoFromDocumentId({
    documentId,
    entryId,
    attachmentId,
    upsertAttachment,
}: {
    documentId: string
    entryId: string
    attachmentId: string
    upsertAttachment: (
        blob: Blob,
        id: string,
        fileName?: string,
        metadata?: any,
    ) => Promise<void> // Make sure this matches your UpsertAttachment type
}) {
    console.log('[Hydration] Starting hydration for:', {
        documentId,
        entryId,
        attachmentId,
    })

    const s3Client = new S3Client({
        region: REACT_APP_AWS_REGION,
        credentials: {
            accessKeyId: REACT_APP_AWS_S3_BUCKET_USER_KEY,
            secretAccessKey: REACT_APP_AWS_S3_BUCKET_USER_SECRET,
        },
    })

    try {
        const doc = await fetchDocumentById(documentId)
        console.log('[Hydration] Document fetched:', doc)

        const { bucket, key, fileName } = parseS3Path(doc.file_path)!
        console.log('[Hydration] S3 path parsed:', { bucket, key, fileName })

        const command = new GetObjectCommand({ Bucket: bucket, Key: key })
        const response = await s3Client.send(command)

        const contentType =
            fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')
                ? 'image/jpeg'
                : fileName.endsWith('.png')
                  ? 'image/png'
                  : 'application/octet-stream'

        const blob = await streamToBlob(response.Body, contentType)
        console.log('[Hydration] Blob created:', {
            size: blob.size,
            type: blob.type,
        })

        const metadata = await getMetadataFromPhoto(blob)
        console.log('[Hydration] Metadata extracted:', metadata)

        // Wait for the attachment to be fully persisted
        await upsertAttachment(blob, entryId, fileName, metadata)
        console.log(
            `[Hydration] Successfully injected ${attachmentId} into attachments`,
        )
    } catch (err) {
        console.error(
            '[Hydration] Failed to hydrate building number photo:',
            err,
        )
        throw err
    }
}

export async function deleteDocumentById(documentId: string) {
    const response = await fetch(
        `${REACT_APP_VAPORCORE_URL}/api/documents/${documentId}`,
        {
            method: 'DELETE',
        },
    )

    if (!response.ok) {
        throw new Error(`Failed to delete document ${documentId}`)
    }

    return true
}
