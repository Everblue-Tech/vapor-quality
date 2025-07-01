import React, {
    useState,
    type FC,
    useEffect,
    SetStateAction,
    useRef,
    useContext,
} from 'react'
import { ListGroup, Button, Modal } from 'react-bootstrap'
import { LinkContainer } from 'react-router-bootstrap'
import { TfiTrash, TfiPencil, TfiArrowDown } from 'react-icons/tfi'
import { useNavigate, useLocation } from 'react-router-dom'
import { deleteEmptyProjects, useDB } from '../utilities/database_utils'
import ImportDoc from './import_document_wrapper'
import ExportDoc from './export_document_wrapper'
import { persistSessionState, StoreContext } from './store'
import { getConfig } from '../config'
import {
    hydratePhotoFromDocumentId,
    deleteDocumentById,
} from '../utilities/s3_utils'

// define interface for the initialization data
interface InitFormData {
    user_id: string
    application_id: string
    step_id: string
    process_id: string
    organization_id: string
    measures: string[]
    project_name?: string
    street_address?: string
    city?: string
    state?: string
    zip_code?: string
    technician_name?: string
    installation_company?: string
    company_address?: string
    company_phone?: string
    company_email?: string
    applicant_first_name?: string
    applicant_last_name?: string
    applicant_email?: string
    applicant_phone?: string
}

/**
 * Home:  Renders the Home page for the APP
 *
 * @returns ListGroup component displaying the projects created
 */
const Home: FC = () => {
    const navigate = useNavigate()
    const location = useLocation()
    const [projectList, setProjectList] = useState<any[]>([])
    const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false)
    const [selectedProjectToDelete, setSelectedProjectToDelete] = useState('')
    const [selectedProjectNameToDelete, setSelectedProjectNameToDelete] =
        useState('')
    // state variables that hold list of entries retrieved from vapor-core for a given process_id and user_id
    const [userId, setUserId] = useState<string | null>(null)
    const [applicationId, setApplicationId] = useState<string | null>(null)
    const [processStepId, setProcessStepId] = useState<string | null>(null)
    const [processId, setProcessId] = useState<string | null>(null)
    const [formPrefillData, setFormPrefillData] = useState<
        Partial<InitFormData>
    >({})
    const hasHydratedRef = useRef(false)
    const [isHydrating, setIsHydrating] = useState(false)

    const db = useDB()

    const REACT_APP_VAPORCORE_URL = getConfig('REACT_APP_VAPORCORE_URL')
    const REACT_APP_VAPORFLOW_URL = getConfig('REACT_APP_VAPORFLOW_URL')

    const { upsertAttachment } = useContext(StoreContext)

    // listen for postMessage from the parent window (vapor-flow) to initialize form metadata
    window.parent.postMessage({ type: 'REQUEST_INIT_FORM_DATA' }, '*')

    useEffect(() => {
        const allowedOrigin = REACT_APP_VAPORFLOW_URL
        function handleMessage(event: MessageEvent) {
            // only allow messages from vapor-flow
            if (event.origin !== allowedOrigin) {
                console.warn(
                    '[vapor-quality] Rejected message from unexpected origin:',
                    event.origin,
                )
                return
            }

            if (event.data?.type === 'INIT_FORM_DATA') {
                const payload = event.data.payload as InitFormData

                // Store basic session data
                localStorage.setItem('user_id', payload.user_id)
                localStorage.setItem('application_id', payload.application_id)
                localStorage.setItem('process_step_id', payload.step_id)
                localStorage.setItem('process_id', payload.process_id)
                localStorage.setItem('organization_id', payload.organization_id)
                localStorage.setItem(
                    'measures',
                    JSON.stringify(payload.measures),
                )

                // Store prefill data
                const prefillData: Partial<InitFormData> = {
                    project_name: payload.project_name,
                    street_address: payload.street_address,
                    city: payload.city,
                    state: payload.state,
                    zip_code: payload.zip_code,
                    technician_name: payload.technician_name,
                    installation_company: payload.installation_company,
                    company_address: payload.company_address,
                    company_phone: payload.company_phone,
                    company_email: payload.company_email,
                    applicant_first_name: payload.applicant_first_name,
                    applicant_last_name: payload.applicant_last_name,
                    applicant_email: payload.applicant_email,
                    applicant_phone: payload.applicant_phone,
                }

                // Store prefill data in localStorage for persistence
                localStorage.setItem(
                    'form_prefill_data',
                    JSON.stringify(prefillData),
                )

                setUserId(payload.user_id)
                setApplicationId(payload.application_id)
                setProcessStepId(payload.step_id)
                setProcessId(payload.process_id)
                setFormPrefillData(prefillData)
            }
        }

        window.addEventListener('message', handleMessage)
        return () => window.removeEventListener('message', handleMessage)
    }, [])

    // persist session state to localStorage whenever metadata changes - helps retain values across navigation/refreshes
    useEffect(() => {
        persistSessionState({ userId, applicationId, processId, processStepId })
    }, [userId, applicationId, processId, processStepId])

    // Load prefill data from localStorage on component mount
    useEffect(() => {
        const storedPrefillData = localStorage.getItem('form_prefill_data')
        if (storedPrefillData) {
            try {
                const parsedData = JSON.parse(storedPrefillData)
                setFormPrefillData(parsedData)
            } catch (error) {
                console.error('Error parsing stored prefill data:', error)
            }
        }
    }, [])

    const refreshAndHydrateData = async () => {
        if (!userId || !processStepId) {
            console.log(
                '[Refresh] Missing user or process info, skipping refresh',
            )
            return
        }

        if (!db) {
            console.log('[Refresh] Database not ready, skipping refresh')
            return
        }

        console.log('[Refresh] Starting full refresh...')
        setIsHydrating(true)

        try {
            // Get all current docs
            const allDocs = await db.allDocs()

            // Delete all existing docs
            const docsToDelete = allDocs.rows.map(
                (row: { id: string; value: { rev: string } }) => ({
                    _id: row.id,
                    _rev: row.value.rev,
                    _deleted: true,
                }),
            )

            if (docsToDelete.length > 0) {
                console.log('[Refresh] Clearing existing documents...')
                await db.bulkDocs(docsToDelete)
            }

            // Reset hydration flag
            hasHydratedRef.current = false

            // Re-hydrate from RDS
            console.log('[Refresh] Re-hydrating from RDS...')
            await hydrateFromRDS()

            // Refresh UI
            await retrieveProjectInfo()

            console.log('[Refresh] Full refresh complete')
        } catch (error) {
            console.error('[Refresh] Error during refresh:', error)
        } finally {
            setIsHydrating(false)
        }
    }

    // initial data load
    useEffect(() => {
        // add small delay to ensure component is fully mounted
        const timer = setTimeout(() => {
            refreshAndHydrateData().catch(error => {
                console.error(
                    '[Initial Load] Error during initial data load:',
                    error,
                )
            })
        }, 100)

        return () => clearTimeout(timer)
    }, [])

    // Hydrate from RDS when we have user and process info
    useEffect(() => {
        if (userId && processStepId && !hasHydratedRef.current) {
            hydrateFromRDS().then(() => {
                hasHydratedRef.current = true
            })
        }
    }, [userId, processStepId])

    // Clean up empty projects on mount
    useEffect(() => {
        deleteEmptyProjects(db)
    }, [])

    // Refresh when navigating back to projects list
    useEffect(() => {
        // Check if we're at the root path (projects list)
        if (location.pathname === '/' || location.pathname === '') {
            console.log(
                '[Navigation] Returned to projects list, refreshing data',
            )
            // If we have user and process info, do a full refresh
            if (userId && processStepId) {
                refreshAndHydrateData()
            } else {
                // Otherwise just refresh the local data
                retrieveProjectInfo()
            }
        }
    }, [location, userId, processStepId])

    const retrieveProjectInfo = async (): Promise<void> => {
        try {
            // ensure db is ready
            if (!db) {
                console.log(
                    '[retrieveProjectInfo] Database not ready, skipping',
                )
                return
            }

            const { retrieveProjectDocs } = await import(
                '../utilities/database_utils'
            )

            const res = await retrieveProjectDocs(db)
            console.log('[retrieveProjectInfo] Loaded from PouchDB:', res)

            setProjectList(res)
            sortByEditTime(res)
        } catch (error) {
            console.error(
                '[retrieveProjectInfo] Error retrieving projects:',
                error,
            )
            // set empty project list on error
            setProjectList([])
        }
    }

    const hydrateFromRDS = async () => {
        if (!userId || !processStepId) {
            console.log('[hydrateFromRDS] Missing required params:', {
                userId,
                processStepId,
            })
            return
        }

        setIsHydrating(true)
        console.log('[hydrateFromRDS] Starting hydration...')

        try {
            const response = await fetch(
                `${REACT_APP_VAPORCORE_URL}/api/quality-install?user_id=${userId}&process_step_id=${processStepId}`,
            )

            if (!response.ok) {
                const err = await response.json()
                console.warn('[hydrateFromRDS] No saved form data:', err)
                return
            }

            const result = await response.json()
            const rdsProjects = result.forms
            console.log('[hydrateFromRDS] Retrieved from RDS:', rdsProjects)

            for (const entry of rdsProjects) {
                console.log('[hydrateFromRDS] Processing entry:', entry.id)

                const exists = await db.get(entry.id).catch(() => null)

                // 🔍 GET THE ATTACHMENTS METADATA FROM RDS DATA
                const formData = entry.form_data
                const attachmentsFromRDS =
                    formData?.metadata_?.attachments || {}
                console.log(
                    '[hydrateFromRDS] RDS attachments metadata:',
                    JSON.stringify(attachmentsFromRDS, null, 2),
                )

                if (!exists) {
                    console.log(
                        '[hydrateFromRDS] Entry does not exist, creating...',
                    )

                    if (!formData?.metadata_ || !formData?.data_) {
                        console.warn(
                            '[hydrateFromRDS] Skipped incomplete form data:',
                            entry.id,
                        )
                        continue
                    }

                    const docToInsert = {
                        _id: entry.id,
                        metadata_: formData.metadata_,
                        data_: formData.data_,
                        type: 'project',
                    }

                    try {
                        const result = await db.put(docToInsert)
                        console.log(
                            '[hydrateFromRDS] Successfully wrote doc:',
                            result,
                        )
                    } catch (e) {
                        console.error(
                            '[hydrateFromRDS] Failed to write doc:',
                            entry.id,
                            e,
                        )
                        continue
                    }
                } else {
                    console.log(
                        '[hydrateFromRDS] Document exists, checking attachments...',
                    )

                    // Check if existing doc has all the attachments it should have
                    const existingAttachments = exists._attachments || {}
                    console.log(
                        '[hydrateFromRDS] Existing doc attachments:',
                        Object.keys(existingAttachments),
                    )
                    console.log(
                        '[hydrateFromRDS] Expected attachments from RDS:',
                        Object.keys(attachmentsFromRDS),
                    )

                    // Find missing attachments
                    const missingAttachments = Object.keys(
                        attachmentsFromRDS,
                    ).filter(attachmentId => !existingAttachments[attachmentId])
                    console.log(
                        '[hydrateFromRDS] Missing attachments:',
                        missingAttachments,
                    )
                }

                // 🔧 HYDRATE ATTACHMENTS (whether doc is new or existing)
                if (Object.keys(attachmentsFromRDS).length > 0) {
                    console.log('[hydrateFromRDS] Processing attachments...')

                    // Create a temporary upsert function for hydration
                    const tempUpsertAttachment = async (
                        blob: Blob,
                        id: string,
                        fileName?: string,
                        photoMetadata?: any,
                    ) => {
                        console.log(
                            `[TempUpsert] Starting attachment storage for ${id}`,
                        )
                        console.log(`[TempUpsert] Blob info:`, {
                            size: blob.size,
                            type: blob.type,
                        })

                        try {
                            const metadata = photoMetadata || {
                                filename: fileName,
                                timestamp: new Date().toISOString(),
                            }
                            console.log(`[TempUpsert] Metadata:`, metadata)

                            // Store metadata in the document
                            const currentDoc = await db.get(entry.id)
                            console.log(
                                `[TempUpsert] Current doc rev:`,
                                currentDoc._rev,
                            )

                            const updatedDoc = {
                                ...currentDoc,
                                metadata_: {
                                    ...currentDoc.metadata_,
                                    attachments: {
                                        ...currentDoc.metadata_?.attachments,
                                        [id]: metadata,
                                    },
                                },
                            }

                            const metadataResult = await db.put(updatedDoc)
                            console.log(
                                `[TempUpsert] Metadata stored, new rev:`,
                                metadataResult.rev,
                            )

                            // Store the blob attachment
                            const attachmentResult = await db.putAttachment(
                                entry.id,
                                id,
                                metadataResult.rev,
                                blob,
                                blob.type,
                            )
                            console.log(
                                `[TempUpsert] Attachment stored:`,
                                attachmentResult,
                            )

                            // Verify the attachment was stored
                            const finalDoc = await db.get(entry.id)
                            console.log(
                                `[TempUpsert] Final doc attachments:`,
                                Object.keys(finalDoc._attachments || {}),
                            )
                        } catch (error) {
                            console.error(
                                `[TempUpsert] Error storing attachment ${id}:`,
                                error,
                            )
                            throw error
                        }
                    }

                    for (const [attachmentId, meta] of Object.entries(
                        attachmentsFromRDS,
                    ) as [string, { documentId: string }][]) {
                        console.log(
                            `[hydrateFromRDS] Processing attachment: ${attachmentId}`,
                            meta,
                        )

                        if (meta?.documentId) {
                            console.log(
                                '[hydrateFromRDS] Hydrating attachment:',
                                { attachmentId, documentId: meta.documentId },
                            )

                            try {
                                await hydratePhotoFromDocumentId({
                                    documentId: meta.documentId,
                                    entryId: attachmentId,
                                    attachmentId,
                                    upsertAttachment: tempUpsertAttachment,
                                })
                                console.log(
                                    `[hydrateFromRDS] Successfully hydrated ${attachmentId}`,
                                )
                            } catch (attachmentError) {
                                console.error(
                                    `[hydrateFromRDS] Failed to hydrate ${attachmentId}:`,
                                    attachmentError,
                                )
                            }
                        } else {
                            console.log(
                                `[hydrateFromRDS] Skipping attachment ${attachmentId} - no documentId`,
                            )
                        }
                    }
                } else {
                    console.log(
                        '[hydrateFromRDS] No attachments to process for',
                        entry.id,
                    )
                }
            }

            hasHydratedRef.current = true
            console.log(
                '[hydrateFromRDS] Hydration complete, refreshing project list...',
            )
            await retrieveProjectInfo()
            console.log('[hydrateFromRDS] Project list refreshed')
        } catch (e) {
            console.error('[hydrateFromRDS] Error hydrating from RDS:', e)
        } finally {
            setIsHydrating(false)
            console.log('[hydrateFromRDS] Hydration process ended')
        }
    }

    const prefillNewProject = async (projectId: string) => {
        try {
            const projectDoc = await db.get(projectId)

            // map state abbreviations to full names
            const stateMapping: { [key: string]: string } = {
                AL: 'Alabama',
                AK: 'Alaska',
                AZ: 'Arizona',
                AR: 'Arkansas',
                CA: 'California',
                CO: 'Colorado',
                CT: 'Connecticut',
                DE: 'Delaware',
                FL: 'Florida',
                GA: 'Georgia',
                HI: 'Hawaii',
                ID: 'Idaho',
                IL: 'Illinois',
                IN: 'Indiana',
                IA: 'Iowa',
                KS: 'Kansas',
                KY: 'Kentucky',
                LA: 'Louisiana',
                ME: 'Maine',
                MD: 'Maryland',
                MA: 'Massachusetts',
                MI: 'Michigan',
                MN: 'Minnesota',
                MS: 'Mississippi',
                MO: 'Missouri',
                MT: 'Montana',
                NE: 'Nebraska',
                NV: 'Nevada',
                NH: 'New Hampshire',
                NJ: 'New Jersey',
                NM: 'New Mexico',
                NY: 'New York',
                NC: 'North Carolina',
                ND: 'North Dakota',
                OH: 'Ohio',
                OK: 'Oklahoma',
                OR: 'Oregon',
                PA: 'Pennsylvania',
                RI: 'Rhode Island',
                SC: 'South Carolina',
                SD: 'South Dakota',
                TN: 'Tennessee',
                TX: 'Texas',
                UT: 'Utah',
                VT: 'Vermont',
                VA: 'Virginia',
                WA: 'Washington',
                WV: 'West Virginia',
                WI: 'Wisconsin',
                WY: 'Wyoming',
            }

            // get full state name, fall back to original value if not found
            const stateValue = formPrefillData.state || ''
            const fullStateName = stateMapping[stateValue] || stateValue

            const prefillStructure = {
                data_: {
                    project_info: {
                        project_name: formPrefillData.project_name || '',
                    },
                    installer: {
                        name: formPrefillData.technician_name || '',
                        company_name:
                            formPrefillData.installation_company || '',
                        mailing_address: formPrefillData.company_address || '',
                        phone: formPrefillData.company_phone || '',
                        email: formPrefillData.company_email || '',
                    },
                    location: {
                        street_address: formPrefillData.street_address || '',
                        city: formPrefillData.city || '',
                        state: fullStateName,
                        zip_code: formPrefillData.zip_code || '',
                    },
                    applicant_info: {
                        first_name: formPrefillData.applicant_first_name || '',
                        last_name: formPrefillData.applicant_last_name || '',
                        email: formPrefillData.applicant_email || '',
                        phone: formPrefillData.applicant_phone || '',
                    },
                },
                metadata_: {
                    ...projectDoc.metadata_,
                    prefilled: true,
                    prefill_timestamp: new Date().toISOString(),
                },
            }

            // Update the project document with prefilled data
            const updatedDoc = {
                ...projectDoc,
                ...prefillStructure,
            }

            await db.put(updatedDoc)
            console.log('Project prefilled with data:', prefillStructure)
        } catch (error) {
            console.error('Error prefilling project:', error)
        }
    }

    const handleAddJob = async () => {
        // Dynamically import the function when needed
        const { putNewProject } = await import('../utilities/database_utils')
        // Create project name from prefill data if available
        const projectName =
            formPrefillData.project_name ||
            `${formPrefillData.applicant_first_name || ''} ${formPrefillData.applicant_last_name || ''}`.trim() ||
            formPrefillData.street_address ||
            'New Project'

        const updatedDBDoc: any = await putNewProject(db, projectName, '')

        // If we have prefill data, immediately populate the project
        if (updatedDBDoc && Object.keys(formPrefillData).length > 0) {
            await prefillNewProject(updatedDBDoc.id)
        }

        // Refresh the project list after adding the new project
        await retrieveProjectInfo()
        if (updatedDBDoc) editAddressDetails(updatedDBDoc.id)
    }

    const handleDeleteJob = (docId: string) => {
        setSelectedProjectToDelete(docId)
        setShowDeleteConfirmation(true)
    }

    const confirmDeleteJob = async () => {
        try {
            // Get the project document
            const projectDoc: any = await db.get(selectedProjectToDelete)

            // Get all installation docs
            const installDocs: any = await db.allDocs({
                keys: projectDoc.children,
                include_docs: true,
            })

            // Delete S3 documents and PouchDB attachments for the project and its installations
            const deleteDocumentAndAttachments = async (doc: any) => {
                if (doc?.metadata_?.attachments) {
                    const attachments = doc.metadata_.attachments
                    for (const [attachmentId, meta] of Object.entries(
                        attachments,
                    )) {
                        // Delete from vapor-core if it exists
                        if ((meta as any).documentId) {
                            try {
                                await deleteDocumentById(
                                    (meta as any).documentId,
                                )
                            } catch (error) {
                                console.error(
                                    'Error deleting S3 document:',
                                    error,
                                )
                            }
                        }

                        // Remove attachment from PouchDB
                        try {
                            const currentDoc = await db.get(doc._id)
                            await db.removeAttachment(
                                doc._id,
                                attachmentId,
                                currentDoc._rev,
                            )
                            console.log(
                                `Removed attachment ${attachmentId} from document ${doc._id}`,
                            )
                        } catch (error) {
                            console.error(
                                `Error removing attachment ${attachmentId} from PouchDB:`,
                                error,
                            )
                        }
                    }
                }
            }

            // Delete S3 documents and attachments for the project
            await deleteDocumentAndAttachments(projectDoc)

            // Delete S3 documents and attachments for each installation
            for (const row of installDocs.rows) {
                if (row.doc) {
                    await deleteDocumentAndAttachments(row.doc)
                }
            }

            // Filter jobs/installations linked to the projects and mark for deletion
            const docsToDelete: any = installDocs.rows
                .filter((row: { doc: any }) => !!row.doc)
                .map((row: { doc: { _id: any; _rev: any } }) => ({
                    _deleted: true,
                    _id: row.doc?._id,
                    _rev: row.doc?._rev,
                }))

            // Performing bulk delete of jobs/installation docs
            if (docsToDelete.length > 0) {
                await db.bulkDocs(docsToDelete)
            }

            // Deleting the project document
            await db.remove(projectDoc)

            // Refresh the project list after deletion
            await retrieveProjectInfo()
        } catch (error) {
            console.error('Error deleting project doc:', error)
        } finally {
            setShowDeleteConfirmation(false)
            setSelectedProjectToDelete('')
        }
    }

    const handleDelete = (
        event: React.MouseEvent,
        key: { _id: string; metadata_: { doc_name: SetStateAction<string> } },
    ) => {
        event.stopPropagation()
        event.preventDefault()
        handleDeleteJob(key._id)
        setSelectedProjectNameToDelete(key.metadata_?.doc_name)
    }

    const sortByEditTime = (jobsList: any[]) => {
        jobsList.sort((a, b) => {
            if (
                a.metadata_.last_modified_at.toString() <
                b.metadata_.last_modified_at.toString()
            ) {
                return 1
            } else if (
                a.metadata_.last_modified_at.toString() >
                b.metadata_.last_modified_at.toString()
            ) {
                return -1
            } else {
                return 0
            }
        })
    }

    const cancelDeleteJob = () => {
        setShowDeleteConfirmation(false)
        setSelectedProjectToDelete('')
    }

    const editAddressDetails = (projectID: string) => {
        navigate('app/' + projectID, { replace: true })
    }

    const projects_display =
        Object.keys(projectList).length === 0
            ? []
            : projectList.map((key, value) => (
                  <div key={key._id}>
                      <ListGroup key={key._id} className="padding">
                          <LinkContainer
                              key={key}
                              to={`/app/${key._id}/workflows`}
                              onClick={() =>
                                  localStorage.setItem(
                                      'selected_doc_id',
                                      key._id,
                                  )
                              }
                          >
                              <ListGroup.Item key={key._id} action={true}>
                                  <span className="icon-container">
                                      {/* <Menu options={options} /> */}

                                      <Button
                                          variant="light"
                                          onClick={event => {
                                              event.stopPropagation()
                                              event.preventDefault()
                                              editAddressDetails(key._id)
                                          }}
                                      >
                                          <TfiPencil size={22} />
                                      </Button>
                                      <Button
                                          variant="light"
                                          onClick={event =>
                                              handleDelete(event, key)
                                          }
                                      >
                                          <TfiTrash size={22} />
                                      </Button>
                                      <ExportDoc
                                          docId={key._id}
                                          docName={key.metadata_?.doc_name}
                                          includeChild={true}
                                      />
                                  </span>
                                  <b>{key.metadata_?.doc_name}</b>
                                  {/* Show prefilled indicator */}
                                  {key.metadata_?.prefilled && (
                                      <span className="badge bg-info ms-2">
                                          Prefilled
                                      </span>
                                  )}
                                  {key.data_?.location?.street_address && (
                                      <>
                                          <br />
                                          {key.data_?.location?.street_address},
                                      </>
                                  )}
                                  {key.data_?.location?.city && (
                                      <>
                                          <br />
                                          {key.data_?.location?.city},{' '}
                                      </>
                                  )}
                                  {key.data_.location?.state && (
                                      <>{key.data_?.location?.state} </>
                                  )}
                                  {key.data_.location?.zip_code && (
                                      <>{key.data_?.location?.zip_code}</>
                                  )}
                              </ListGroup.Item>
                          </LinkContainer>
                      </ListGroup>
                  </div>
              ))

    const hasPrefillData = Object.keys(formPrefillData).some(
        key => formPrefillData[key as keyof typeof formPrefillData],
    )

    return (
        <>
            {isHydrating ? (
                <div
                    className="d-flex justify-content-center align-items-center"
                    style={{ minHeight: '200px' }}
                >
                    <div className="spinner-border text-primary" role="status">
                        <span className="visually-hidden">Loading...</span>
                    </div>
                </div>
            ) : (
                <div>
                    {/* Show prefill data indicator */}
                    {hasPrefillData && (
                        <div className="alert alert-info mb-3">
                            <strong>
                                Form data received from parent application
                            </strong>
                            <details className="mt-2">
                                <summary>View received data</summary>
                                <pre
                                    className="mt-2 mb-0"
                                    style={{ fontSize: '0.8em' }}
                                >
                                    {JSON.stringify(formPrefillData, null, 2)}
                                </pre>
                            </details>
                        </div>
                    )}
                    {Object.keys(projectList).length == 0 && (
                        <center>
                            <br />
                            <p className="welcome-header">
                                Welcome to the Quality Install Tool
                            </p>
                            <br />
                            <p className="welcome-content">
                                With this tool you will be able <br /> to easily
                                take photos and document <br />
                                your entire installation project. <br />
                                <br />
                                <br />
                                For your records
                                <br />
                                For your clients
                                <br />
                                For quality assurance reporting
                            </p>
                            <div className="button-container-center" key={0}>
                                <Button
                                    onClick={handleAddJob}
                                    alt-text="Add a New Project"
                                >
                                    {hasPrefillData
                                        ? 'Create Project with Prefilled Data'
                                        : 'Add a New Project'}
                                </Button>
                                <ImportDoc
                                    id="project_json"
                                    label="Import a Project"
                                />
                            </div>
                        </center>
                    )}
                    {Object.keys(projectList).length > 0 && (
                        <div>
                            {projectList.length === 0 && (
                                <div className="align-right padding">
                                    <Button
                                        onClick={handleAddJob}
                                        alt-text="Add a New Project"
                                    >
                                        {hasPrefillData
                                            ? 'Create Project with Prefilled Data'
                                            : 'Add a New Project'}
                                    </Button>
                                    <ImportDoc
                                        id="project_json"
                                        label="Import Project"
                                    />
                                </div>
                            )}
                            {projectList.length > 0 && (
                                <div>{projects_display}</div>
                            )}
                        </div>
                    )}
                </div>
            )}
            <br />
            <center>
                <p className="welcome-content">
                    <br />
                    Click here to learn more about the{' '}
                    <a
                        href="https://www.pnnl.gov/projects/quality-install-tool"
                        target="_blank"
                    >
                        Quality Install Tool
                    </a>
                </p>
            </center>
            <Modal show={showDeleteConfirmation} onHide={cancelDeleteJob}>
                <Modal.Header closeButton>
                    <Modal.Title>Confirm Delete</Modal.Title>
                </Modal.Header>
                <Modal.Body>
                    Are you sure you want to permanently delete{' '}
                    <b>{selectedProjectNameToDelete}</b>? This action cannot be
                    undone.
                </Modal.Body>
                <Modal.Footer>
                    <Button variant="secondary" onClick={cancelDeleteJob}>
                        Cancel
                    </Button>
                    <Button variant="danger" onClick={confirmDeleteJob}>
                        Permanently Delete
                    </Button>
                </Modal.Footer>
            </Modal>
        </>
    )
}

export default Home
