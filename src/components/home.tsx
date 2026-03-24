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

// Type assertion wrapper to fix TypeScript compatibility issue
const LinkContainerWrapper = LinkContainer as any
import { TfiTrash, TfiPencil, TfiArrowDown } from 'react-icons/tfi'
import { useNavigate, useLocation } from 'react-router-dom'
import { deleteEmptyProjects, useDB } from '../utilities/database_utils'
import ImportDoc from './import_document_wrapper'
import ExportDoc from './export_document_wrapper'
import {
    persistSessionState,
    StoreContext,
    closeProcessStepWithPartialMeasuresComplete,
    hasAtLeastOneMeasureComplete,
} from './store'
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
    const [showCloseStepConfirmation, setShowCloseStepConfirmation] =
        useState(false)
    const [hasCompletedMeasure, setHasCompletedMeasure] = useState(false)
    const [isCheckingMeasures, setIsCheckingMeasures] = useState(false)
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
    console.log(
        '[PREFILL STEP 1] Requesting INIT_FORM_DATA from parent window (vapor-flow)',
    )
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
                console.log(
                    '[PREFILL STEP 2] Received INIT_FORM_DATA from vapor-flow',
                )
                const payload = event.data.payload as InitFormData
                console.log('[PREFILL STEP 2] Payload received:', {
                    user_id: payload.user_id,
                    application_id: payload.application_id,
                    process_step_id: payload.step_id,
                    process_id: payload.process_id,
                    organization_id: payload.organization_id,
                    measures: payload.measures,
                })

                // Store basic session data
                console.log(
                    '[PREFILL STEP 3] Storing session data in localStorage',
                )
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
                console.log(
                    '[PREFILL STEP 3] Prefill data prepared:',
                    prefillData,
                )

                // Store prefill data in localStorage for persistence
                localStorage.setItem(
                    'form_prefill_data',
                    JSON.stringify(prefillData),
                )
                console.log(
                    '[PREFILL STEP 3] Prefill data stored in localStorage',
                )

                setUserId(payload.user_id)
                setApplicationId(payload.application_id)
                setProcessStepId(payload.step_id)
                setProcessId(payload.process_id)
                setFormPrefillData(prefillData)
                console.log(
                    '[PREFILL STEP 3] React state updated with session data',
                )
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
        if (!applicationId || !processStepId || !userId) {
            console.log(
                '[Refresh] Missing application, user, or process info, skipping refresh',
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
            // get all current docs
            let allDocs
            try {
                allDocs = await db.allDocs()
            } catch (docError) {
                console.warn(
                    '[Refresh] Could not retrieve docs for cleanup:',
                    docError,
                )
                allDocs = { rows: [] }
            }

            // delete all existing docs
            if (allDocs.rows.length > 0) {
                const docsToDelete = allDocs.rows.map(
                    (row: { id: string; value: { rev: string } }) => ({
                        _id: row.id,
                        _rev: row.value.rev,
                        _deleted: true,
                    }),
                )

                try {
                    console.log('[Refresh] Clearing existing documents...')
                    await db.bulkDocs(docsToDelete)
                } catch (deleteError) {
                    console.warn('[Refresh] Error clearing docs:', deleteError)
                }
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
            // try to load local projects
            try {
                await retrieveProjectInfo()
            } catch (fallbackError) {
                console.error(
                    '[Refresh] Fallback project loading failed:',
                    fallbackError,
                )
            }
        } finally {
            setIsHydrating(false)
        }
    }

    // initial data load - wait for database to be ready
    useEffect(() => {
        if (db) {
            if (applicationId && processStepId && userId) {
                // Full refresh with RDS hydration
                const timer = setTimeout(() => {
                    refreshAndHydrateData().catch(error => {
                        console.error(
                            '[Initial Load] Error during initial data load:',
                            error,
                        )
                    })
                }, 500)
                return () => clearTimeout(timer)
            } else {
                // just load local projects if no application/process data
                const timer = setTimeout(() => {
                    retrieveProjectInfo().catch(error => {
                        console.error(
                            '[Initial Load] Error loading local projects:',
                            error,
                        )
                    })
                }, 300)
                return () => clearTimeout(timer)
            }
        }
    }, [db, applicationId, processStepId, userId])

    // Hydrate from RDS when we have application and process info
    useEffect(() => {
        if (
            applicationId &&
            processStepId &&
            userId &&
            !hasHydratedRef.current
        ) {
            hydrateFromRDS().then(() => {
                hasHydratedRef.current = true
            })
        }
    }, [applicationId, processStepId, userId])

    // Clean up empty projects on mount
    useEffect(() => {
        // add safety check and delay to prevent PouchDB errors
        if (db) {
            setTimeout(() => {
                deleteEmptyProjects(db).catch(error => {
                    console.warn('Error cleaning empty projects:', error)
                })
            }, 1000)
        }
    }, [db])

    // Check if at least one measure is complete to show the close button
    useEffect(() => {
        const checkMeasureCompletion = async () => {
            if (!processId || !processStepId || !userId) {
                setHasCompletedMeasure(false)
                return
            }

            setIsCheckingMeasures(true)
            try {
                const hasCompleted = await hasAtLeastOneMeasureComplete(
                    processId,
                    processStepId,
                    userId,
                )
                setHasCompletedMeasure(hasCompleted)
            } catch (error) {
                console.error('Error checking measure completion:', error)
                setHasCompletedMeasure(false)
            } finally {
                setIsCheckingMeasures(false)
            }
        }

        checkMeasureCompletion()

        // Refresh the check periodically (every 30 seconds)
        const interval = setInterval(checkMeasureCompletion, 30000)

        return () => clearInterval(interval)
    }, [processId, processStepId, userId])

    // Refresh when navigating back to projects list
    // DISABLED: This was causing PouchDB errors when navigating back from canceled projects
    /*
    useEffect(() => {
        // Check if we're at the root path (projects list)
        if (location.pathname === '/' || location.pathname === '') {
            console.log(
                '[Navigation] Returned to projects list, refreshing data',
            )
            // Add safety checks and error handling
            if (db) {
                if (userId && processStepId) {
                    refreshAndHydrateData().catch(error => {
                        console.error(
                            '[Navigation] Error during refresh:',
                            error,
                        )
                        // Fallback to local data on error
                        retrieveProjectInfo().catch(fallbackError => {
                            console.error(
                                '[Navigation] Fallback also failed:',
                                fallbackError,
                            )
                        })
                    })
                } else {
                    // Just refresh local data
                    retrieveProjectInfo().catch(error => {
                        console.error(
                            '[Navigation] Error refreshing local data:',
                            error,
                        )
                    })
                }
            }
        }
    }, [location, userId, processStepId, db])
    */

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
        console.log(
            '[PREFILL STEP 4] hydrateFromRDS() called - Starting RDS hydration process',
        )
        if (!applicationId || !processStepId) {
            console.log(
                '[PREFILL STEP 4] Missing required params - cannot hydrate:',
                {
                    applicationId,
                    processStepId,
                },
            )
            return
        }

        setIsHydrating(true)
        console.log('[PREFILL STEP 4] Hydration starting with params:', {
            userId,
            applicationId,
            processStepId,
        })

        try {
            // check to see if a project already exists for this process_step_id
            const apiUrl = `${REACT_APP_VAPORCORE_URL}/api/quality-install?user_id=${userId}&process_step_id=${processStepId}`
            console.log(
                '[PREFILL STEP 5] Fetching existing data from vapor-core:',
                apiUrl,
            )
            const existingResponse = await fetch(apiUrl)

            let shouldCreateFromApplication = false
            let existingData = null

            if (existingResponse.ok) {
                const existingResult = await existingResponse.json()
                existingData = existingResult.forms
                console.log(
                    '[PREFILL STEP 5] SUCCESS - Found existing data for process_step_id:',
                    {
                        formsCount: existingData?.length || 0,
                        formIds: existingData?.map((f: any) => f.id) || [],
                    },
                )
                console.log(
                    '[PREFILL STEP 5] Full existing data:',
                    JSON.stringify(existingData, null, 2),
                )
            } else {
                console.log(
                    '[PREFILL STEP 5] No existing data for process_step_id (status:',
                    existingResponse.status,
                    ')',
                )
                console.log(
                    '[PREFILL STEP 5] Will attempt to create from application data',
                )
                shouldCreateFromApplication = true
            }

            // if no existing data for this process_step_id, get application data
            if (shouldCreateFromApplication) {
                const appApiUrl = `${REACT_APP_VAPORCORE_URL}/api/quality-install/application/${applicationId}`
                console.log(
                    '[PREFILL STEP 6] Fetching application data from vapor-core:',
                    appApiUrl,
                )
                const appResponse = await fetch(appApiUrl)

                if (!appResponse.ok) {
                    console.warn(
                        '[PREFILL STEP 6] No application data found (status:',
                        appResponse.status,
                        ')',
                    )
                    return
                }

                const appResult = await appResponse.json()
                console.log(
                    '[PREFILL STEP 6] SUCCESS - Found application data:',
                    {
                        formsCount: appResult.forms?.length || 0,
                    },
                )

                const appForms = appResult.forms

                if (!appForms || appForms.length === 0) {
                    console.warn(
                        '[PREFILL STEP 6] No forms found for application - nothing to hydrate',
                    )
                    return
                }

                // get the most recent form
                const mostRecentForm = appForms[appForms.length - 1]
                console.log('[PREFILL STEP 6] Using most recent form:', {
                    formId: mostRecentForm.id,
                    hasMetadata: !!mostRecentForm.form_data?.metadata_,
                    hasData: !!mostRecentForm.form_data?.data_,
                })

                // create a new entry for this process_step_id based on the most recent application data
                const newFormData = {
                    ...mostRecentForm.form_data,
                    // Update metadata to reflect new process_step_id
                    metadata_: {
                        ...mostRecentForm.form_data.metadata_,
                        process_step_id: processStepId,
                        created_from_application: true,
                        source_form_id: mostRecentForm.id,
                        created_at: new Date().toISOString(),
                    },
                }

                // create new project entry in the DB in quality_install_form_data
                console.log(
                    '[PREFILL STEP 7] Creating new entry in quality_install_form_data table via POST',
                )
                const createResponse = await fetch(
                    `${REACT_APP_VAPORCORE_URL}/api/quality-install`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            user_id: userId,
                            application_id: applicationId,
                            process_step_id: processStepId,
                            form_data: newFormData,
                        }),
                    },
                )

                if (createResponse.ok) {
                    const createdResult = await createResponse.json()
                    existingData = [createdResult]
                    console.log(
                        '[PREFILL STEP 7] SUCCESS - Created new entry in vapor-core',
                    )
                } else {
                    console.error(
                        '[PREFILL STEP 7] FAILED to create new entry (status:',
                        createResponse.status,
                        ')',
                    )
                    return
                }
            }

            // process data (newly created or existing entry)
            if (!existingData || existingData.length === 0) {
                console.warn(
                    '[PREFILL STEP 8] No data to process - hydration complete with no data',
                )
                return
            }

            console.log(
                '[PREFILL STEP 8] Processing',
                existingData.length,
                'form(s) from RDS',
            )
            const rdsProjects = existingData

            for (const entry of rdsProjects) {
                console.log('[PREFILL STEP 8] Processing entry:', entry.id)
                const exists = await db.get(entry.id).catch(() => null)

                // GET THE ATTACHMENTS METADATA FROM RDS DATA
                const formData = entry.form_data
                const attachmentsFromRDS =
                    formData?.metadata_?.attachments || {}

                // Log summary info
                console.log('[PREFILL STEP 8] Form data from RDS:', {
                    entryId: entry.id,
                    measureName: formData?.metadata_?.doc_name || 'unknown',
                    hasMetadata: !!formData?.metadata_,
                    hasData: !!formData?.data_,
                    attachmentsCount: Object.keys(attachmentsFromRDS).length,
                    attachmentIds: Object.keys(attachmentsFromRDS),
                })

                // Log full metadata (for debugging prefill issues)
                console.log(
                    '[PREFILL STEP 8] Full metadata_ to hydrate:',
                    JSON.stringify(formData?.metadata_, null, 2),
                )

                // Log full data (form field values)
                console.log(
                    '[PREFILL STEP 8] Full data_ to hydrate (form values):',
                    JSON.stringify(formData?.data_, null, 2),
                )

                // Log attachments with their documentIds (for image hydration)
                if (Object.keys(attachmentsFromRDS).length > 0) {
                    console.log('[PREFILL STEP 8] Attachments to hydrate:')
                    Object.entries(attachmentsFromRDS).forEach(
                        ([key, value]: [string, any]) => {
                            console.log(
                                `  - ${key}: documentId=${value?.documentId || 'NONE'}, hasGeolocation=${!!value?.geolocation}`,
                            )
                        },
                    )
                }

                if (!exists) {
                    console.log(
                        '[PREFILL STEP 9] Document does NOT exist in PouchDB - will create',
                    )

                    if (!formData?.metadata_ || !formData?.data_) {
                        console.warn(
                            '[PREFILL STEP 9] Skipped incomplete form data (missing metadata_ or data_):',
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
                    console.log(
                        '[PREFILL STEP 9] Writing document to PouchDB:',
                        {
                            docId: entry.id,
                            metadataKeys: Object.keys(formData.metadata_ || {}),
                            dataKeys: Object.keys(formData.data_ || {}),
                        },
                    )

                    try {
                        const result = await db.put(docToInsert)
                        console.log(
                            '[PREFILL STEP 9] SUCCESS - Document written to PouchDB:',
                            result,
                        )
                    } catch (e) {
                        console.error(
                            '[PREFILL STEP 9] FAILED to write document to PouchDB:',
                            entry.id,
                            e,
                        )
                        continue
                    }
                } else {
                    console.log(
                        '[PREFILL STEP 9] Document ALREADY EXISTS in PouchDB - checking attachments',
                    )

                    // Check if existing doc has all the attachments it should have
                    const existingAttachments = exists._attachments || {}
                    console.log(
                        '[PREFILL STEP 9] Existing PouchDB attachments:',
                        Object.keys(existingAttachments),
                    )
                    console.log(
                        '[PREFILL STEP 9] Expected attachments from RDS:',
                        Object.keys(attachmentsFromRDS),
                    )

                    // Find missing attachments
                    const missingAttachments = Object.keys(
                        attachmentsFromRDS,
                    ).filter(attachmentId => !existingAttachments[attachmentId])
                    console.log(
                        '[PREFILL STEP 9] Missing attachments to hydrate:',
                        missingAttachments,
                    )
                }

                // HYDRATE ATTACHMENTS (whether doc is new or existing)
                if (Object.keys(attachmentsFromRDS).length > 0) {
                    console.log(
                        '[PREFILL STEP 10] Processing',
                        Object.keys(attachmentsFromRDS).length,
                        'attachment(s)...',
                    )

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
        // Each measure gets its own project - don't force reuse
        // The measure name (doc_name) will be set when user selects a template
        console.log('[handleAddJob] Creating new project for measure')
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

    const handleCloseStepClick = () => {
        setShowCloseStepConfirmation(true)
    }

    const cancelCloseStep = () => {
        setShowCloseStepConfirmation(false)
    }

    const confirmCloseStep = async () => {
        if (!processId || !processStepId || !userId) {
            console.error('Missing required identifiers to close step')
            setShowCloseStepConfirmation(false)
            return
        }

        try {
            await closeProcessStepWithPartialMeasuresComplete(
                processId,
                processStepId,
                userId,
            )
            setShowCloseStepConfirmation(false)
            // Optionally show success message or refresh page
            alert('Process step closed successfully.')
        } catch (error) {
            console.error('Error closing process step:', error)
            alert('Failed to close process step. Please try again.')
        }
    }

    const editAddressDetails = (projectID: string) => {
        navigate('app/' + projectID, { replace: true })
    }

    const projects_display =
        Object.keys(projectList).length === 0
            ? []
            : projectList.map(key => (
                  <div key={key._id}>
                      <ListGroup key={key._id} className="padding">
                          <LinkContainerWrapper
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
                          </LinkContainerWrapper>
                      </ListGroup>
                  </div>
              ))

    const hasPrefillData = Object.keys(formPrefillData).some(
        key => formPrefillData[key as keyof typeof formPrefillData],
    )

    return (
        <>
            {/* Close Process Step Button - Top Right */}
            {hasCompletedMeasure && processId && processStepId && userId && (
                <div
                    style={{
                        position: 'fixed',
                        top: '20px',
                        right: '20px',
                        zIndex: 1000,
                    }}
                >
                    <Button
                        variant="primary"
                        onClick={handleCloseStepClick}
                        disabled={isCheckingMeasures}
                    >
                        Close Process Step
                    </Button>
                </div>
            )}
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
                    {/* Show prefill data indicator - FOR DEBUG ONLY */}
                    {/* {hasPrefillData && (
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
                    )} */}
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
                        className="link-blue"
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
            <Modal show={showCloseStepConfirmation} onHide={cancelCloseStep}>
                <Modal.Header closeButton>
                    <Modal.Title>Confirm Close Process Step</Modal.Title>
                </Modal.Header>
                <Modal.Body>
                    Are you sure you have completed all the needed forms for all
                    measures?
                </Modal.Body>
                <Modal.Footer>
                    <Button variant="secondary" onClick={cancelCloseStep}>
                        Cancel
                    </Button>
                    <Button variant="primary" onClick={confirmCloseStep}>
                        Confirm
                    </Button>
                </Modal.Footer>
            </Modal>
        </>
    )
}

export default Home
