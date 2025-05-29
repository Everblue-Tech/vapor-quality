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
<<<<<<< HEAD
import { getAuthToken } from '../auth/keycloak'
import jsPDF from 'jspdf'
import { uploadImageToS3AndCreateDocument } from '../utilities/s3_utils'
import { S3Config } from './home'
=======
import jsPDF from 'jspdf'
import { measureTypeMapping } from '../templates/templates_config'
import { getConfig } from '../config'
import { uploadImageToS3AndCreateDocument } from '../utilities/s3_utils'
>>>>>>> beaa9b39d92de997e5997eef604d338f1cd0b809

PouchDB.plugin(PouchDBUpsert)

export type FormEntry = {
    id: string
    process_step_id: string
    user_id: string
    form_data: any
    created_at: string
    updated_at: string | null
}

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
<<<<<<< HEAD
        docDataMap: Record<string, any>
=======
>>>>>>> beaa9b39d92de997e5997eef604d338f1cd0b809
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
    userId: null as string | null,
    applicationId: null as string | null,
    processId: null as string | null,
    processStepId: null as string | null,
    selectedFormId: null as string | null,
    setSelectedFormId: (() => {}) as React.Dispatch<
        React.SetStateAction<string | null>
    >,
    handleFormSelect: (() => {}) as (form: FormEntry) => void,
    formEntries: [] as FormEntry[],
    s3Config: null as S3Config | null,
})

interface StoreProviderProps {
    children: ReactNode
    dbName: string | undefined
    docId: string
    workflowName: string
    docName: string
    type: string
    parentId?: string | undefined
    userId: string | null
    applicationId: string | null
    processId: string | null
    processStepId: string | null
    selectedFormId: string | null
    setSelectedFormId: React.Dispatch<React.SetStateAction<string | null>>
    handleFormSelect: (form: FormEntry | null) => void
    formEntries: FormEntry[]
    s3Config?: S3Config | null
}

export type FormEntry = {
    id: string
    process_step_id: string
    user_id: string
    form_data: any
    created_at: string
    updated_at: string | null
}

const REACT_APP_VAPORCORE_URL = getConfig('REACT_APP_VAPORCORE_URL')

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
    userId,
    applicationId,
    processId,
    processStepId,
    selectedFormId,
    setSelectedFormId,
    handleFormSelect,
    formEntries,
    s3Config,
}) => {
    // ensure docDataMap is always initialized
    if (typeof window !== 'undefined' && !window.docDataMap) {
        window.docDataMap = {}
    }
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

    const selectedFormIdRef = useRef<string | null>(null)

    useEffect(() => {
        selectedFormIdRef.current = selectedFormId
    }, [selectedFormId])

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

        // Ensure form data is persisted globally
        if (dbDoc.data_) {
            window.docData = dbDoc.data_
        }

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
<<<<<<< HEAD
                // Check if the doc already exists before trying to create it
                const existingDoc = await db.get(docId)
                revisionRef.current = existingDoc._rev
            } catch (err: any) {
                if (err.status === 404) {
                    // Only create the doc if it doesn't exist
=======
                const normalizedDocId = docId === '0' ? undefined : docId

                // Check if the document already exists
                let existingDoc: any = null
                if (normalizedDocId) {
                    existingDoc = await db
                        .get(normalizedDocId)
                        .catch(() => null)
                }

                if (!existingDoc) {
>>>>>>> beaa9b39d92de997e5997eef604d338f1cd0b809
                    const result = !isInstallationDoc
                        ? await putNewProject(db, docName, docId)
                        : await putNewInstallation(
                              db,
                              docId,
                              workflowName,
                              docName,
                              parentId as string,
                          )
<<<<<<< HEAD

                    if (
                        result &&
                        typeof result === 'object' &&
                        'rev' in result &&
                        typeof result.rev === 'string'
                    ) {
                        revisionRef.current = result.rev
                    } else {
                        console.warn(
                            'Unexpected result from document creation:',
                            result,
                        )
                    }
                }
=======
                    revisionRef.current = (
                        result as unknown as PouchDB.Core.Response
                    ).rev
                } else {
                    revisionRef.current = existingDoc._rev
                }
            } catch (err) {
                console.error('DB initialization error:', err)
                // TODO: Rethink how best to handle errors
>>>>>>> beaa9b39d92de997e5997eef604d338f1cd0b809
            }

            // Initialize doc and attachments state from the DB document
            try {
                const dbDoc = await db.get(docId)
                processDBDocChange(db, dbDoc)
            } catch (err: any) {
                if (err.status === 404 || err.name === 'not_found') {
                    // pouchDB throws a 404 missing error when db.get(docId) is called but docId doesn't exist yet
                    console.info(
                        `No existing document found for docId: ${docId}`,
                    )
                } else {
                    console.error('Unable to initialize state from DB:', err)
                }
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
     * Updates (or inserts) a value into the `data_` property of the document state and persists it to the DB.
     *
     * @remarks
     * This function is typically passed through `StoreContext.Provider` and used by form inputs to update the document.
     * It prefixes the provided path with `data_.` to ensure updates are scoped to the `data_` field in the document.
     * It also updates the global `window.docData` and `window.docDataMap` objects for in-memory tracking across sessions.
     *
     * @param pathStr A dot/bracket notation path such as "foo.bar[2].biz" pointing to where the value should be inserted inside `data_`.
     * @param value The value that is to be updated/inserted at the specified path
     */

    const upsertData: UpsertData = (pathStr, value) => {
        pathStr = 'data_.' + pathStr
<<<<<<< HEAD
        // create updated doc with new value immutably inserted
        const updatedDoc = immutableUpsert(
            doc,
            toPath(pathStr) as NonEmptyArray<string>,
            value,
        )
        setDoc(updatedDoc)

        // update global window.docData and window.docDataMap for in-memory access
        const newData = updatedDoc.data_
        window.docData = newData
        if (typeof window !== 'undefined' && selectedFormIdRef.current) {
            if (!window.docDataMap) {
                window.docDataMap = {}
            }
            window.docDataMap[selectedFormIdRef.current] = newData
        }

        // persist the updated document to the DB
        if (db != null) {
            db.upsert(docId, function upsertFn(dbDoc: any) {
                const result = { ...dbDoc, ...updatedDoc }
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
=======
        upsertDoc(pathStr, value)
        window.docData = doc.data_
>>>>>>> beaa9b39d92de997e5997eef604d338f1cd0b809
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

        // Store the blob in memory
        const newAttachments = {
            ...attachments,
            [id]: {
                blob,
                metadata,
            },
        }

        setAttachments(newAttachments)

        // Persist the blob
        const upsertBlobDB = async (
            rev: string,
        ): Promise<PouchDB.Core.Response | null> => {
            let result = null
            if (db != null) {
                try {
                    result = await db.putAttachment(
                        docId,
                        id,
                        rev,
                        blob,
                        blob.type,
                    )
                } catch (err) {
                    // Try again with the latest rev value
                    const doc = await db.get(docId)
                    result = await upsertBlobDB(doc._rev)
                } finally {
                    if (result != null) {
                        revisionRef.current = result.rev
                    }
                }
            }
            return result
        }

        if (revisionRef.current) {
            upsertBlobDB(revisionRef.current)
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
                userId,
                applicationId,
                processId,
                processStepId,
                selectedFormId,
                setSelectedFormId,
                handleFormSelect,
                formEntries,
                s3Config: s3Config ?? null,
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

<<<<<<< HEAD
export const saveProjectAndUploadToS3 = async (projectDoc: any) => {
    try {
        const pdf = new jsPDF()
        pdf.text(
            `Project: ${projectDoc.metadata_.doc_name || 'Untitled Project'}`,
            10,
            10,
        )
        pdf.text('Quality Install Tool Report', 10, 20)

        const reportData = {
            projectName: projectDoc.metadata_.doc_name,
            ...projectDoc.data_,
        }

        pdf.text(JSON.stringify(reportData, null, 2), 10, 30)
        const pdfBlob = pdf.output('blob')

        const s3Response = await fetch(
            'http://localhost:5000/api/s3/FILL_ME_IN', // CHANGE TO S3 PRSIGNED URL - need to generate on backend to make put
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${getAuthToken()}`,
                },
                body: JSON.stringify({
                    file_name: `quality_install_${projectDoc.metadata_.doc_name || 'Untitled Project'}_${Date.now()}.pdf`,
                    file_type: 'application/pdf',
                }),
            },
        )
        const s3Data = await s3Response.json()
        if (!s3Data.success) {
            console.error('Failed to get S3 presigned URL:', s3Data)
            return
        }
        console.log('Uploading PDF to S3:', s3Data.url)
        const uploadResponse = await fetch(s3Data.url, {
            method: 'PUT',
            body: pdfBlob,
            headers: { 'Content-Type': 'application/pdf' },
        })
        if (!uploadResponse.ok) {
            console.error('Failed to upload PDF to S3:', uploadResponse)
            return
        }
        let formId = localStorage.getItem('form_id')
        const updateResponse = await fetch(
            `http://localhost:5000/api/quality-install/${formId}`,
            {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${getAuthToken()}`,
                },
                body: JSON.stringify({ s3_file_url: s3Data.url }),
            },
        )
        const updateData = await updateResponse.json()
        if (updateData.success) {
            console.log(
                'Successfully saved project and updated DB with S3 URL:',
                updateData,
            )
        } else {
            console.error('Failed to update DB with S3 file URL:', updateData)
        }
        const { processId, userId, processStepId } = extractLocalStorageData()
        const conditionResponse = await fetch(
            `http://localhost:5000/api/process/${processId}/step/${processStepId}/condition`,
            {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${getAuthToken()}`,
                },
                body: JSON.stringify({ condition: 'CLOSED' }),
            },
        )
        if (!conditionResponse.ok) {
            console.error(
                'Failed to update step condition to CLOSED:',
                conditionResponse,
            )
            return
        }
        const projectDocName = projectDoc.metadata_.doc_name
        const conditionData = await conditionResponse.json()
        console.log('Step condition updated:', conditionData)
        const NewQualityInstallSubmissionData =
            await storeNewQualityInstallSubmission(
                projectDocName,
                [],
                formId,
                userId,
                processId,
                processStepId,
            )
        console.log('Local Storage Updated:', NewQualityInstallSubmissionData)
    } catch (error) {
        console.error('Error in saveProjectAndUploadToS3:', error)
    }
}

function storeNewQualityInstallSubmission(
    submissionName: string,
    formData: any,
    applicationId: any,
    userId: string,
    processId: string,
    stepId: string,
    localStorageKey = 'quality_install_submission',
) {
    const newObject = {
        [submissionName]: {
            form_data: formData,
            application_id: applicationId,
            user_id: userId,
            process_id: processId,
            step_id: stepId,
        },
    }

    localStorage.setItem(localStorageKey, JSON.stringify(newObject))
}

function extractLocalStorageData() {
    const prequalificationData = localStorage.getItem(
        'formData_prequalification',
    )
    let processId = null
    let userId = null

    if (prequalificationData) {
        try {
            const parsedData = JSON.parse(prequalificationData)
            processId = parsedData.process_id || null
            userId = parsedData.user?.user_id || null
        } catch (error) {
            console.error('Error parsing formData_prequalification:', error)
        }
    }
    let processStepId = localStorage.getItem('process_step_id') || ''
    return {
        processId: processId,
        userId: userId,
        processStepId: processStepId,
    }
}

export const isFormComplete = (formData: any, metadata?: any): boolean => {
    if (!formData) return false
    if (!formData.installer) {
        console.warn('Missing required installer data')
        return false
    }

    const installerFields = [
        'name',
        'company_name',
        'mailing_address',
        'phone',
        'email',
    ]
    for (const field of installerFields) {
        if (
            !formData.installer[field] ||
            formData.installer[field].trim() === ''
        ) {
            return false
        }
    }
    if (!formData.location) {
        return false
    }
    const locationFields = ['street_address', 'city', 'state', 'zip_code']
    for (const field of locationFields) {
        if (
            !formData.location[field] ||
            formData.location[field].trim() === ''
        ) {
            return false
        }
    }
    return true
}

=======
>>>>>>> beaa9b39d92de997e5997eef604d338f1cd0b809
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

<<<<<<< HEAD
/**
 * Saves or updates the current form data to the vapor-core backend database (Amazon RDS).
 *
 * @remarks
 * If a `form_id` already exists in localStorage, this function attempts to update the existing form by sending a PUT request.
 * If the form does not exist (404), it automatically tries to create a new one via a POST request.
 * If no `form_id` exists initially, it creates a new form entry via a POST request and stores the returned `form_id` in localStorage.
 *
 * Optionally, after creating a new form, it updates the selected form ID state and calls the `handleFormSelect` callback.
 * It's "optional" because React UI state updates (setSelectedFormId, handleFormSelect) are only triggered if those callback functions are provided by the caller while the backend save works either way.
 *
 * @param userId - the user ID passed into the vapor-quality iframe from vapor-flow
 * @param processStepId - the process step ID passed into the vapor-quality iframe from vapor-flow
 * @param form_data - the form data payload to save
 * @param setSelectedFormId - optional setter function to update the selected form ID in state
 * @param handleFormSelect - optional functino to select the newly created form entry after creation
 * @returns
 */
=======
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
        `${REACT_APP_VAPORCORE_URL}/api/process/${processId}/step/${processStepId}/form-data`,
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
            `${REACT_APP_VAPORCORE_URL}/api/process/${processId}/step/${processStepId}/form-data?user_id=${userId}`,
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
            `${REACT_APP_VAPORCORE_URL}/api/process/${processId}/step/${processStepId}/condition`,
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
>>>>>>> beaa9b39d92de997e5997eef604d338f1cd0b809

export const saveToVaporCoreDB = async (
    userId: string | null,
    processStepId: string | null,
    form_data: any,
    setSelectedFormId?: (id: string) => void,
    handleFormSelect?: (form: FormEntry) => void,
    fileToUpload?: Blob | File | null,
): Promise<void> => {
    if (!userId || !processStepId) {
        console.warn('Missing userId or processStepId in saveToVaporCoreDB')
        return
    }

    let formId = localStorage.getItem('form_id')

    const formData = {
        user_id: userId,
        process_step_id: processStepId,
        form_data: form_data,
    }

    let uploadedDocumentId

<<<<<<< HEAD
    console.log(fileToUpload)

=======
>>>>>>> beaa9b39d92de997e5997eef604d338f1cd0b809
    try {
        // if file and valid s3Config provided, upload file to s3
        if (fileToUpload) {
            try {
                const organizationId = localStorage.getItem('organization_id')
                if (!organizationId) {
                    console.error('Missing organizationId in localStorage')
                } else {
                    uploadedDocumentId = await uploadImageToS3AndCreateDocument(
                        {
                            file: fileToUpload,
                            userId,
                            organizationId,
                            documentType: 'quality install photo',
<<<<<<< HEAD
                        },
                    )
                    console.log(`Uploaded document ID: ${uploadedDocumentId}`)
=======
                            measureName: 'project-photo',
                        },
                    )
>>>>>>> beaa9b39d92de997e5997eef604d338f1cd0b809
                    if (uploadedDocumentId) {
                        if (!form_data.documents) {
                            form_data.documents = []
                        }
                        form_data.documents.push({
                            document_id: uploadedDocumentId,
                            documentType: 'quality install photo',
                        })
                    }
                }
            } catch (err) {
                console.error(
                    'Failed to upload photo to s3 and create document:',
                    err,
                )
            }
        }

        let response: Response

        if (formId) {
            try {
                const response = await fetch(
                    `http://localhost:5000/api/quality-install/${formId}`,
                    {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/json',
<<<<<<< HEAD
                            Authorization: `Bearer ${getAuthToken()}`,
=======
>>>>>>> beaa9b39d92de997e5997eef604d338f1cd0b809
                        },
                        body: JSON.stringify(formData),
                    },
                )

                if (response.status === 404) {
                    console.warn(
                        `Form with id ${formId} not found. Attempting to create.`,
                    )
                    // Try POST to create it
                    const createResponse = await fetch(
                        `http://localhost:5000/api/quality-install`,
                        {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
<<<<<<< HEAD
                                Authorization: `Bearer ${getAuthToken()}`,
=======
>>>>>>> beaa9b39d92de997e5997eef604d338f1cd0b809
                            },
                            body: JSON.stringify({
                                id: formId,
                                ...formData,
                            }),
                        },
                    )
                    if (!createResponse.ok) {
                        throw new Error(
                            `Failed to create form with id ${formId}`,
                        )
                    }
                } else if (!response.ok) {
                    throw new Error(`Failed to update form with id ${formId}`)
                }
            } catch (error) {
                console.error('Error saving to Vapor Core DB:', error)
                throw error
            }
        } else {
            // no formId, create a new one
            response = await fetch(
                'http://localhost:5000/api/quality-install',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
<<<<<<< HEAD
                        Authorization: `Bearer ${getAuthToken()}`,
=======
>>>>>>> beaa9b39d92de997e5997eef604d338f1cd0b809
                    },
                    body: JSON.stringify(formData),
                },
            )

            const data = await response.json()
            formId = data.form_data_id as string
            localStorage.setItem('form_id', formId)

            if (setSelectedFormId && handleFormSelect) {
                const newEntry: FormEntry = {
                    id: formId,
                    user_id: userId!,
                    process_step_id: processStepId!,
                    form_data: formData.form_data,
                    created_at: new Date().toISOString(),
                    updated_at: null,
                }

                setSelectedFormId(formId)
                handleFormSelect(newEntry)
            }
        }
    } catch (error) {
        console.error('Error saving to RDS:', error)
    }
}
<<<<<<< HEAD
=======

export const fetchExistingRDSForm = async (
    userId: string,
    processStepId: string,
): Promise<any | null> => {
    const response = await fetch(
        `http://localhost:5000/api/quality-install?user_id=${userId}&process_step_id=${processStepId}`,
        {
            method: 'GET',
        },
    )

    if (!response.ok) {
        console.warn('No form data found or error fetching from RDS')
        return null
    }

    const data = await response.json()
    if (data.success && data.forms?.length > 0) {
        return data.forms[0] // each process/process_step only has 1 project entry
    }

    return null
}

function base64ToBlob(base64: string, contentType: string): Blob {
    const byteCharacters = atob(base64)
    const byteNumbers = new Array(byteCharacters.length)
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i)
    }
    const byteArray = new Uint8Array(byteNumbers)
    return new Blob([byteArray], { type: contentType })
}

export const hydrateFromRDS = async (rdsEntry: any, db: PouchDB.Database) => {
    try {
        if (!rdsEntry || !rdsEntry.form_data) {
            console.warn('No form_data found in RDS entry, skipping hydration.')
            return
        }

        // Check if project already exists
        const existing = await db.allDocs({ include_docs: true })
        const projectExists = existing.rows.some(doc =>
            doc.id.startsWith('project_'),
        )

        if (projectExists) {
            console.log(
                'Local PouchDB already populated with project document.',
            )
            return
        }

        const RESERVED_KEYS = new Set(['_id', '_rev', '_attachments'])
        const importedDocs: Record<string, any> = {}
        const childrenIds: string[] = []

        for (const [docId, docBody] of Object.entries(rdsEntry.form_data) as [
            string,
            Record<string, any>,
        ][]) {
            if (!docId || typeof docBody !== 'object' || docBody === null)
                continue
            if (RESERVED_KEYS.has(docId)) continue

            const idToUse = docBody._id || docId
            if (!idToUse) continue

            const { _attachments, ...docWithoutAttachments } = docBody
            await db.put({ ...docWithoutAttachments, _id: idToUse })
            importedDocs[idToUse] = docBody

            // Put attachments if they exist
            if (_attachments) {
                for (const [attachmentId, attachment] of Object.entries(
                    _attachments,
                ) as [string, { data: string; content_type: string }][]) {
                    const blob = base64ToBlob(
                        attachment.data,
                        attachment.content_type,
                    )
                    await db.putAttachment(
                        idToUse,
                        attachmentId,
                        blob,
                        attachment.content_type,
                    )
                }
            }

            // track install docs (everything that's not metadata_ or data_)
            if (!['metadata_', 'data_'].includes(idToUse)) {
                childrenIds.push(idToUse)
            }
        }

        // add top-level project document that links to metadata_ and data_
        const projectId = `project_${rdsEntry.id}`
        const projectDoc = {
            _id: projectId,
            metadata_: importedDocs['metadata_'],
            data_: importedDocs['data_'],
            children: childrenIds,
        }

        await db.put(projectDoc)

        if (rdsEntry.id) {
            localStorage.setItem('form_id', rdsEntry.id)
        }

        console.log(`Hydrated project into PouchDB: ${projectId}`)
    } catch (err) {
        console.error('Error hydrating from RDS:', err)
    }
}
>>>>>>> beaa9b39d92de997e5997eef604d338f1cd0b809
