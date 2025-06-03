import React, {
    useState,
    type FC,
    useEffect,
    SetStateAction,
    useRef,
} from 'react'
import { ListGroup, Button, Modal } from 'react-bootstrap'
import { LinkContainer } from 'react-router-bootstrap'
import { TfiTrash, TfiPencil, TfiArrowDown } from 'react-icons/tfi'
import { useNavigate } from 'react-router-dom'
import { deleteEmptyProjects, useDB } from '../utilities/database_utils'
import ImportDoc from './import_document_wrapper'
import ExportDoc from './export_document_wrapper'
import {
    fetchExistingRDSForm,
    hydrateFromRDS,
    persistSessionState,
} from './store'
import { getConfig } from '../config'

// Define interface for the initialization data
interface InitFormData {
    user_id: string
    application_id: string
    step_id: string
    process_id: string
    organization_id: string
    measures: string[]
    // Add fields that should prefill the form
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

    // listen for postMessage from the parent window (vapor-flow) to initialize form metadata
    useEffect(() => {
        window.parent.postMessage({ type: 'REQUEST_INIT_FORM_DATA' }, '*')
    }, [])

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

    useEffect(() => {
        const hydrateAndRetrieve = async () => {
            if (!userId || !processStepId) return
            try {
                const rdsEntry = await fetchExistingRDSForm(
                    userId,
                    processStepId,
                )
                if (rdsEntry) {
                    await hydrateFromRDS(rdsEntry, db)
                    // refresh UI after hydration
                    await retrieveProjectInfo()
                } else {
                    // still retrieve even if nothing to hydrate
                    await retrieveProjectInfo()
                }
            } catch (error) {
                console.error('Error during hydration:', error)
            }
        }

        hydrateAndRetrieve()
    }, [userId, processStepId])

    // persist session state to localStorage whenever metadata changes - helps retain values across navigation/refreshes
    useEffect(() => {
        persistSessionState({ userId, applicationId, processId, processStepId })
    }, [userId, applicationId, processId, processStepId])

    const retrieveProjectInfo = async (): Promise<void> => {
        // Dynamically import the function when needed
        const { retrieveProjectDocs } = await import(
            '../utilities/database_utils'
        )

        retrieveProjectDocs(db).then(res => {
            setProjectList(res)
            sortByEditTime(res)
        })
    }

    useEffect(() => {
        deleteEmptyProjects(db)
    }, [])

    useEffect(() => {
        retrieveProjectInfo()
    }, []) // Only run once on mount

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

    const prefillNewProject = async (projectId: string) => {
        try {
            const projectDoc = await db.get(projectId)

            // Structure the prefill data according to your form structure
            const prefillStructure = {
                data_: {
                    project_info: {
                        project_name: formPrefillData.project_name || '',
                    },
                    installer_info: {
                        technician_name: formPrefillData.technician_name || '',
                        installation_company:
                            formPrefillData.installation_company || '',
                        company_address: formPrefillData.company_address || '',
                        company_phone: formPrefillData.company_phone || '',
                        company_email: formPrefillData.company_email || '',
                    },
                    location: {
                        street_address: formPrefillData.street_address || '',
                        city: formPrefillData.city || '',
                        state: formPrefillData.state || '',
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

    const handleDeleteJob = (docId: string) => {
        setSelectedProjectToDelete(docId)
        setShowDeleteConfirmation(true)
    }

    const confirmDeleteJob = async () => {
        try {
            // delete the selected project
            const projectDoc: any = await db.get(selectedProjectToDelete)

            const installDocs: any = await db.allDocs({
                keys: projectDoc.children,
                include_docs: true,
            })

            // Filter jobs/installations linked to the projects and mark for deletion
            const docsToDelete: any = installDocs.rows
                .filter((row: { doc: any }) => !!row.doc) // Filter out rows without a document
                .map((row: { doc: { _id: any; _rev: any } }) => ({
                    _deleted: true,
                    _id: row.doc?._id,
                    _rev: row.doc?._rev,
                }))

            // performing bulk delete of jobs/installation doc
            if (docsToDelete.length > 0) {
                const deleteResult = await db.bulkDocs(docsToDelete)
            }
            // Deleting the project document
            await db.remove(projectDoc)

            //Refresh the project list after deletion
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

    // Show available prefill data for debugging
    const hasPrefillData = Object.keys(formPrefillData).some(
        key => formPrefillData[key as keyof typeof formPrefillData],
    )

    return (
        <>
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
                        {projects_display}
                    </div>
                )}
            </div>
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
