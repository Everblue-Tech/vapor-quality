import PouchDB from 'pouchdb'
import PouchDBUpsert from 'pouchdb-upsert'
import React, {
    type FC,
    type ReactNode,
    useEffect,
    useRef,
    useState,
} from 'react'

import { isEmpty, isObject, toPath } from 'lodash'
import type JSONValue from '../types/json_value.type'
import { getMetadataFromPhoto, isPhoto } from '../utilities/photo_utils'
import type Attachment from '../types/attachment.type'
import type { NonEmptyArray } from '../types/misc_types.type'
import type Metadata from '../types/metadata.type'
import {
    putNewProject,
    putNewInstallation,
    useDB,
    exportDocumentAsJSONObject,
} from '../utilities/database_utils'
import EventEmitter from 'events'
import jsPDF from 'jspdf'
import { measureTypeMapping } from '../templates/templates_config'
import { getConfig } from '../config'

PouchDB.plugin(PouchDBUpsert)

type UpsertAttachment = (
    blob: Blob,
    id: string,
    fileName?: string,
    photoMetadata?: Attachment['metadata'],
) => void

type UpsertData = (pathStr: string, value: any) => void

type UpsertMetadata = (pathStr: string, value: any) => void

type UpsertDoc = (pathStr: string, data: any) => void

type Attachments = Record<
    string,
    | Attachment
    | { blob: Blob; digest: string; metadata: Record<string, JSONValue> }
>

declare global {
    interface Window {
        docData: any
    }
}

export const StoreContext = React.createContext({
    docId: '' satisfies string,
    attachments: {} satisfies Attachments,
    data: {} satisfies JSONValue,
    metadata: {} satisfies Metadata | Record<string, string>,
    upsertAttachment: ((
        blob: Blob,
        id: any,
        fileName?,
    ) => {}) as UpsertAttachment,
    deleteAttachment: (attachmentId: string) => {},
    upsertData: ((pathStr: string, data: any) => {}) as UpsertData,
    upsertMetadata: ((pathStr: string, data: any) => {}) as UpsertMetadata,
})

interface StoreProviderProps {
    children: ReactNode
    dbName: string | undefined
    docId: string
    workflowName: string
    docName: string
    type: string
    parentId?: string | undefined
}

/**
 * A wrapper component that connects its children to a data store via React Context
 *
 * @param children - The content wrapped by this component
 * @param dbName - Database name associated with an MDX template
 * @param docId - Document instance id
 */
export const StoreProvider: FC<StoreProviderProps> = ({
    children,
    dbName,
    docId,
    workflowName,
    docName,
    type,
    parentId,
}) => {
    const changesRef = useRef<PouchDB.Core.Changes<{}>>()
    const revisionRef = useRef<string>()
    // The attachments state will have the form: {[att_id]: {blob, digest, metadata}, ...}
    const [attachments, setAttachments] = useState<Record<string, Attachment>>(
        {},
    )
    //This  uses the `useDB` custom hook to create a PouchDB database with the specified `dbName`
    const [db, setDB] = useState<PouchDB.Database>(useDB(dbName))
    // The doc state could be anything that is JSON-compatible
    const [doc, setDoc] = useState<any>({})

    // Determining the doc type for updating it accordingly
    const isInstallationDoc = type === 'installation'

    // Increase the maximum number of listeners for all EventEmitters
    EventEmitter.defaultMaxListeners = 20

    /**
     * Updates component state based on a database document change
     *
     * @param dbDoc The full object representation of the changed document from the database
     */
    async function processDBDocChange(db: PouchDB.Database, dbDoc: any) {
        revisionRef.current = dbDoc._rev

        // Set doc state
        const newDoc: Partial<typeof dbDoc> = { ...dbDoc }
        delete newDoc._attachments
        delete newDoc._id
        delete newDoc._rev

        setDoc(newDoc)

        // Update the attachments state as needed
        // Note: dbDoc will not have a _attachments field if the document has no attachments
        if (db && dbDoc.hasOwnProperty('_attachments') && dbDoc._id == docId) {
            // Collect all the new or modified attachments
            const dbDocAttachments = dbDoc._attachments
            const attachmentsMetadata = dbDoc.metadata_.attachments
            let newAttachments: Record<string, Attachment> = {}
            for (const attachmentId in dbDocAttachments) {
                const docAttachment = dbDocAttachments[attachmentId]

                const attachmentIdParts = attachmentId.split('.')

                const singleAttachmentMetadata =
                    attachmentIdParts.length === 3
                        ? attachmentsMetadata[attachmentIdParts[0]]?.[
                              attachmentIdParts[1]
                          ]?.[attachmentIdParts[2]]
                        : attachmentsMetadata[attachmentId]

                // digest is a hash of the attachment, so a different digest indicates a modified attachment
                const digest = docAttachment?.digest
                if (
                    digest != null &&
                    (!attachments.hasOwnProperty(attachmentId) ||
                        attachments[attachmentId].digest !== digest)
                ) {
                    const blobOrBuffer = await db.getAttachment(
                        docId,
                        attachmentId,
                    )

                    if (blobOrBuffer instanceof Blob) {
                        const blob = blobOrBuffer
                        const metadata: Record<string, any> =
                            singleAttachmentMetadata as Record<string, any>

                        newAttachments = {
                            ...newAttachments,
                            [attachmentId]: {
                                blob,
                                digest,
                                metadata,
                            } satisfies Attachment,
                        }
                    } else {
                        throw new Error('Attachment must be a Blob')
                    }
                }
            }
            if (!isEmpty(newAttachments)) {
                // Update the attachments state
                // Note: We update all new attachments at once to avoid a race condition with state update
                setAttachments({ ...attachments, ...newAttachments })
            }
        }
    }

    useEffect(() => {
        /**
         * Connects the store to the database document
         *
         * @remarks
         * This is an IIFE (Immediately Invoked Function Expression) that
         * (1) Establishes a database connection
         * (2) Initializes the database document if it does not already exist
         * (3) Initializes the doc and attachments state from the database document
         * (4) Subscribes to future changes to the database document — it ignores changes that
         *     originated from this component
         */
        ;(async function connectStoreToDB() {
            try {
                const normalizedDocId = docId === '0' ? undefined : docId

                // Check if the document already exists
                let existingDoc: any = null
                if (normalizedDocId) {
                    existingDoc = await db
                        .get(normalizedDocId)
                        .catch(() => null)
                }

                if (!existingDoc) {
                    const result = !isInstallationDoc
                        ? await putNewProject(db, docName, docId)
                        : await putNewInstallation(
                              db,
                              docId,
                              workflowName,
                              docName,
                              parentId as string,
                          )
                    revisionRef.current = (
                        result as unknown as PouchDB.Core.Response
                    ).rev
                } else {
                    revisionRef.current = existingDoc._rev
                }
            } catch (err) {
                console.error('DB initialization error:', err)
                // TODO: Rethink how best to handle errors
            }
            // Initialize doc and attachments state from the DB document
            try {
                const dbDoc = await db.get(docId)
                processDBDocChange(db, dbDoc)
            } catch (err) {
                console.error('Unable to initialize state from DB:', err)
            }

            // Subscribe to DB document changes
            changesRef.current = db
                .changes({
                    include_docs: true,
                    live: true,
                    since: 'now',
                })
                .on('change', function (change) {
                    if (
                        change.doc != null &&
                        change.doc._rev !== revisionRef.current
                    ) {
                        // The change must have originated from outside this component, so update component state
                        processDBDocChange(db, change.doc)
                    }
                    // else: the change originated from this component, so ignore it
                })
                .on('error', function (err) {
                    // It's hard to imagine what would cause this since our DB is local
                    console.error('DB subscription connection failed')
                })

            // Cancel the DB subscription just before the component unmounts
            return () => {
                if (changesRef.current != null) {
                    changesRef.current.cancel()
                }
            }
        })()

        // Run this effect after the first render and whenever the dbName prop changes
    }, [dbName])

    /**
     * Updates (or inserts) data into the doc state and persists the new doc
     *
     * @remarks
     * The given path is guaranteed to exist after the update/insertion.
     * This function is called internally from upsertData and upsertAttachments function to update the doc with respective information.
     *
     * @param pathStr A string path such as "foo.bar[2].biz" that represents a path into the doc state
     * @param data The data that is to be updated/inserted at the path location in the doc state
     */
    const upsertDoc: UpsertDoc = (pathStr, data) => {
        // Update doc state

        const newDoc = immutableUpsert(
            doc,
            toPath(pathStr) as NonEmptyArray<string>,
            data,
        )
        setDoc(newDoc)

        // Persist the doc
        if (db != null) {
            db.upsert(docId, function upsertFn(dbDoc: any) {
                const result = { ...dbDoc, ...newDoc }
                if (!result.metadata_) {
                    result.metadata_ = {
                        created_at: new Date().toISOString(),
                        last_modified_at: new Date().toISOString(),
                    }
                } else {
                    result.metadata_.last_modified_at = new Date().toISOString()
                }
                return result
            })
                .then(function (res) {
                    revisionRef.current = res.rev
                })
                .catch(function (err: Error) {
                    console.error('upsert error:', err)
                })
        }
    }

    /**
     * Updates (or inserts) data into the data_ property of the doc state by invoking updatedDoc function
     *
     * @remarks
     * This function is typically passed to an input wrapper component via the StoreContext.Provider value
     * This function calls updateDoc, with the path to "data_" in dbDoc.
     *
     * @param pathStr A string path such as "foo.bar[2].biz" that represents a path into the doc state
     * @param value The value that is to be updated/inserted
     */

    const upsertData: UpsertData = (pathStr, value) => {
        pathStr = 'data_.' + pathStr
        upsertDoc(pathStr, value)
        window.docData = doc.data_
    }

    /**
     * Updates (or inserts) metadata into the metadata_ property of the doc state by invoking updatedDoc function
     *
     * @remarks
     * This function is typically passed to an input wrapper component via the StoreContext.Provider value
     * This function calls updateDoc, with the path to "data_" in dbDoc.
     *
     * @param pathStr A string path such as "foo.bar[2].biz" that represents a path into the doc state
     * @param value The value that is to be updated/inserted
     */
    const upsertMetadata: UpsertMetadata = (pathStr, value) => {
        pathStr = 'metadata_.' + pathStr
        upsertDoc(pathStr, value)
    }

    /**
     * Deletes an attachment (file/photo blob) and its associated metadata from a document in the database.
     *
     * This function removes the specified attachment by its ID, updates the document's metadata to reflect
     * the removal, and updates the local state to exclude the deleted attachment.
     *
     * @param {string} attachmentId - The ID of the attachment to delete.
     *
     * @throws {Error} Logs an error to the console if the deletion or update process fails.
     */
    const deleteAttachment = async (attachmentId: string) => {
        try {
            // Fetch the latest document revision
            const docDeleteAttachment: any = await db.get(docId)

            // Remove the attachment with the given attachmentId from the document
            await db.removeAttachment(
                docId,
                attachmentId,
                docDeleteAttachment._rev,
            )

            // Fetch the updated document to update its metadata
            const docRemovePhotoMetadata: any = await db.get(docId)
            const attachmentMetadata = doc.metadata_?.attachments || []

            // Filter out the deleted attachment from metadata
            const updatedAttachmentMetadata = Object.entries(attachmentMetadata)
                .filter(([key, value]) => key !== attachmentId)
                .reduce((acc: any, [key, value]) => {
                    acc[key] = value // Rebuild the object
                    return acc
                }, {})

            // Update the document's metadata with the filtered attachments
            docRemovePhotoMetadata.metadata_ = {
                ...docRemovePhotoMetadata.metadata_,
                attachments: updatedAttachmentMetadata,
            }

            // Update the document with the new metadata
            db.put(docRemovePhotoMetadata).then(function (res) {
                revisionRef.current = res.rev
            })

            // Update the local attachments state by removing the deleted attachment
            const updatedAttachments = Object.entries(attachments)
                .filter(([key, value]) => key !== attachmentId)
                .reduce((acc: any, [key, value]) => {
                    acc[key] = value // Rebuild the object
                    return acc
                }, {})

            setAttachments(updatedAttachments)
        } catch (error) {
            console.error('Error deleting attachment:', error)
        }
    }

    /**
     *
     * @param blob
     * @param id
     */
    // const upsertAttachment: UpsertAttachment = async (
    //     blob: Blob,
    //     id: string,
    //     fileName?: string,
    //     photoMetadata?: Attachment['metadata'],
    // ) => {
    //     const metadata: Attachment['metadata'] = photoMetadata
    //         ? photoMetadata
    //         : isPhoto(blob)
    //           ? await getMetadataFromPhoto(blob)
    //           : {
    //                 filename: fileName,
    //                 timestamp: new Date(Date.now()).toISOString(),
    //             }

    //     // Storing SingleAttachmentMetaData in the DB
    //     upsertMetadata('attachments.' + id, metadata)

    //     // Store the blob in memory
    //     const newAttachments = {
    //         ...attachments,
    //         [id]: {
    //             blob,
    //             metadata,
    //         },
    //     }

    //     setAttachments(newAttachments)

    //     // Persist the blob
    //     const upsertBlobDB = async (
    //         rev: string,
    //     ): Promise<PouchDB.Core.Response | null> => {
    //         let result = null
    //         if (db != null) {
    //             try {
    //                 result = await db.putAttachment(
    //                     docId,
    //                     id,
    //                     rev,
    //                     blob,
    //                     blob.type,
    //                 )
    //             } catch (err) {
    //                 // Try again with the latest rev value
    //                 const doc = await db.get(docId)
    //                 result = await upsertBlobDB(doc._rev)
    //             } finally {
    //                 if (result != null) {
    //                     revisionRef.current = result.rev
    //                 }
    //             }
    //         }
    //         return result
    //     }

    //     if (revisionRef.current) {
    //         upsertBlobDB(revisionRef.current)
    //     }
    // }

    const upsertAttachment: UpsertAttachment = async (
        blob: Blob,
        id: string,
        fileName?: string,
        photoMetadata?: Attachment['metadata'],
    ) => {
        const metadata: Attachment['metadata'] = photoMetadata
            ? photoMetadata
            : isPhoto(blob)
              ? await getMetadataFromPhoto(blob)
              : {
                    filename: fileName,
                    timestamp: new Date(Date.now()).toISOString(),
                }

        // Storing SingleAttachmentMetaData in the DB
        upsertMetadata('attachments.' + id, metadata)

        // Persist the blob with proper revision handling
        const upsertBlobDB = async (
            maxRetries = 3,
        ): Promise<PouchDB.Core.Response | null> => {
            if (!db) {
                console.warn('Database not available')
                return null
            }

            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    // Get the latest document revision
                    let currentRev = revisionRef.current

                    if (!currentRev) {
                        // If no revision available, try to get the document first
                        try {
                            const doc = await db.get(docId)
                            currentRev = doc._rev
                            revisionRef.current = currentRev
                        } catch (err: any) {
                            if (err.name !== 'not_found') {
                                throw err
                            }
                            // Document doesn't exist, currentRev stays undefined
                        }
                    }

                    // Handle undefined revision for new documents
                    let result: PouchDB.Core.Response
                    if (currentRev) {
                        result = await db.putAttachment(
                            docId,
                            id,
                            currentRev,
                            blob,
                            blob.type,
                        )
                    } else {
                        // For new documents, use the overload that doesn't require revision
                        result = await db.putAttachment(
                            docId,
                            id,
                            blob,
                            blob.type,
                        )
                    }

                    // Update the revision reference with the new revision
                    revisionRef.current = result.rev
                    return result
                } catch (err: any) {
                    console.error(`Attempt ${attempt + 1} failed:`, err)

                    if (err.name === 'conflict' && attempt < maxRetries - 1) {
                        // Get the latest revision and try again
                        try {
                            const doc = await db.get(docId)
                            revisionRef.current = doc._rev
                            console.log(
                                `Retrying with updated revision: ${doc._rev}`,
                            )
                        } catch (getErr: any) {
                            if (getErr.name === 'not_found') {
                                // Document was deleted, reset revision
                                revisionRef.current = undefined
                            } else {
                                throw getErr
                            }
                        }
                        // Continue to next iteration
                        continue
                    } else {
                        console.error('Failed to save attachment:', err)
                        throw err
                    }
                }
            }

            throw new Error(
                `Failed to save attachment after ${maxRetries} attempts`,
            )
        }

        try {
            // Wait for the blob to be persisted and get the result
            const result = await upsertBlobDB()

            if (result) {
                // Store the blob in memory with digest from the persistence result
                // We need to get the updated document to get the digest
                const updatedDoc = await db.get(docId)
                const attachmentInfo = updatedDoc._attachments?.[id]

                const newAttachments = {
                    ...attachments,
                    [id]: {
                        blob,
                        digest: attachmentInfo?.digest || '', // Include digest for proper comparison
                        metadata,
                    } satisfies Attachment,
                }

                setAttachments(newAttachments)
                console.log(`Successfully stored attachment: ${id}`)
            }
        } catch (error) {
            console.error('Error persisting attachment:', error)
            // Don't update the in-memory state if persistence failed
            throw error
        }
    }

    return (
        <StoreContext.Provider
            value={{
                attachments,
                docId: docId,
                data: doc.data_,
                metadata: doc.metadata_,
                upsertAttachment,
                deleteAttachment,
                upsertData,
                upsertMetadata,
            }}
        >
            {children}
        </StoreContext.Provider>
    )
}

/**
 * Immutably updates/inserts a target value at a given path
 * @param recipient
 * @param path
 * @param target
 * @returns A shallow copy of recipient that additionally has the value at path set to target
 */
export function immutableUpsert(
    recipient: any,
    path: NonEmptyArray<string>,
    target: any,
): any {
    const [propName, ...newPath] = path
    const newRecipient: any = isObject(recipient)
        ? Array.isArray(recipient)
            ? [...recipient]
            : ({ ...recipient } satisfies Record<string, any>)
        : isNaN(parseInt(propName))
          ? {}
          : []

    if (newPath.length === 0) {
        newRecipient[propName] = target
    } else {
        newRecipient[propName] = immutableUpsert(
            newRecipient[propName as keyof unknown],
            newPath as any,
            target,
        )
    }
    return newRecipient
}

export function persistSessionState({
    userId,
    applicationId,
    processId,
    processStepId,
}: {
    userId?: string | null
    applicationId?: string | null
    processId?: string | null
    processStepId?: string | null
}) {
    if (userId) localStorage.setItem('user_id', userId)
    if (applicationId) localStorage.setItem('application_id', applicationId)
    if (processId) localStorage.setItem('process_id', processId)
    if (processStepId) localStorage.setItem('process_step_id', processStepId)
}

export const updateProcessStepWithMeasure = async ({
    userId,
    processId,
    processStepId,
    measureName,
    finalReportDocumentId,
    jobId,
}: {
    userId: string | null
    processId: string
    processStepId: string
    measureName: string
    finalReportDocumentId: string
    jobId?: string
}) => {
    const response = await fetch(
        `/api/process/${processId}/step/${processStepId}/form-data`,
        {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-user-id': userId ?? '',
            },
            body: JSON.stringify({
                add_measure: {
                    name: measureName,
                    jobs: [
                        {
                            job_id: jobId,
                            status: 'completed',
                            final_report_document_id: finalReportDocumentId,
                        },
                    ],
                },
            }),
        },
    )

    if (!response.ok) {
        throw new Error('Failed to update process step with measure details')
    }

    return await response.json()
}

export const closeProcessStepIfAllMeasuresComplete = async (
    processId: string | null,
    processStepId: string | null,
    userId: string | null,
): Promise<void> => {
    const expectedMeasureNames: string[] = JSON.parse(
        localStorage.getItem('measures') || '[]',
    )

    if (!processId || !processStepId) {
        console.warn('Missing required identifiers.')
        return
    }

    try {
        const formDataRes = await fetch(
            `/api/process/${processId}/step/${processStepId}/form-data?user_id=${userId}`,
            {
                method: 'GET',
            },
        )

        if (!formDataRes.ok) {
            console.error('Failed to fetch form data')
            return
        }

        const formJson = await formDataRes.json()
        const formData = formJson?.data ?? {}
        const actualMeasures = formData?.measures || []

        const allCompleted = expectedMeasureNames.every(expected => {
            const actualNames = measureTypeMapping[expected.toLowerCase()] || []

            return actualMeasures.some(
                (actual: any) =>
                    actualNames.includes(actual.name) &&
                    Array.isArray(actual.jobs) &&
                    actual.jobs.length > 0 &&
                    actual.jobs.every(
                        (job: any) => job.status?.toLowerCase() === 'completed',
                    ),
            )
        })

        if (!allCompleted) {
            console.log('Not all expected measures are marked completed.')
            return
        }

        const closeRes = await fetch(
            `/api/process/${processId}/step/${processStepId}/condition`,
            {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'x-user-id': userId ?? '',
                },
                body: JSON.stringify({ condition: 'CLOSED' }),
            },
        )

        if (!closeRes.ok) {
            const errorBody = await closeRes.text()
            console.error('Failed to close step:', errorBody)
        } else {
            console.log('Process step closed successfully.')
        }
    } catch (error) {
        console.error(' Error:', error)
    }
}

export async function saveProjectToRDS({
    userId,
    processStepId,
    formData,
    docId,
}: {
    userId: string
    processStepId: string
    formData: any
    docId: string
}) {
    const response = await fetch(`/api/quality-install`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            user_id: userId,
            process_step_id: processStepId,
            id: docId,
            form_data: formData,
        }),
    })

    if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to save project info to RDS')
    }

    return await response.json()
}

export async function getProjectsFromRDS(
    userId: string,
    processStepId: string,
) {
    const response = await fetch(
        `/api/quality-install?user_id=${userId}&process_step_id=${processStepId}`,
    )

    if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to fetch project data from RDS')
    }

    const result = await response.json()
    return result.forms
}

export async function fetchDocumentMetadata(
    documentId: string,
): Promise<string | null> {
    const response = await fetch(`/api/documents/${documentId}`)
    if (!response.ok) {
        console.warn(`[fetchDocumentMetadata] Failed for ${documentId}`)
        return null
    }

    const result = await response.json()
    return result?.data?.file_path || null
}
