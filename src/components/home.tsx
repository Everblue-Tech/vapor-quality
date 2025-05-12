import React, {
    useState,
    type FC,
    useEffect,
    SetStateAction,
    useContext,
} from 'react'
import { ListGroup, Button, Modal } from 'react-bootstrap'
import { LinkContainer } from 'react-router-bootstrap'
import { TfiTrash, TfiPencil, TfiArrowDown } from 'react-icons/tfi'
import { useNavigate } from 'react-router-dom'
import { deleteEmptyProjects, useDB } from '../utilities/database_utils'
import ImportDoc from './import_document_wrapper'
import ExportDoc from './export_document_wrapper'
import {
    FormEntry,
    persistSessionState,
    saveToVaporCoreDB,
    StoreContext,
    StoreProvider,
} from '../components/store'
import { getAuthToken } from '../auth/keycloak'
import { prefillFormHardcodedProject } from '../utilities/prefill_form_from_local_storage'

export interface S3Config {
    region?: string
    credentials?: {
        accessKeyId?: string
        secretAccessKey?: string
    }
    kmsKeyId?: string
    bucketName?: string
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
    const [formEntries, setFormEntries] = useState<FormEntry[]>([])
    const [userId, setUserId] = useState<string | null>(null)
    const [applicationId, setApplicationId] = useState<string | null>(null)
    const [processStepId, setProcessStepId] = useState<string | null>(null)
    const [processId, setProcessId] = useState<string | null>(null)
    const db = useDB()
    const [selectedFormId, setSelectedFormId] = useState<string | null>(null)
    const [s3Config, setS3Config] = useState<S3Config | null>(null)

    const retrieveProjectInfo = async (): Promise<void> => {
        const { retrieveProjectDocs } = await import(
            '../utilities/database_utils'
        )

        retrieveProjectDocs(db).then(res => {
            setProjectList(res)
            sortByEditTime(res)
        })
    }

    useEffect(() => {
        window.parent.postMessage({ type: 'REQUEST_INIT_FORM_DATA' }, '*')
    }, [])

    useEffect(() => {
        function handleMessage(event: MessageEvent) {
            if (event.origin !== 'http://localhost:3000') return // need to adjust for dev/prod

            if (event.data?.type === 'INIT_FORM_DATA') {
                const {
                    user_id,
                    application_id,
                    step_id,
                    process_id,
                    organization_id,
                    s3Config,
                } = event.data.payload

                if (
                    user_id &&
                    application_id &&
                    step_id &&
                    process_id &&
                    organization_id &&
                    s3Config
                ) {
                    localStorage.setItem('user_id', user_id)
                    localStorage.setItem('application_id', application_id)
                    localStorage.setItem('process_step_id', step_id)
                    localStorage.setItem('process_id', process_id)
                    localStorage.setItem('organization_id', organization_id)

                    setUserId(user_id)
                    setApplicationId(application_id)
                    setProcessStepId(step_id)
                    setProcessId(process_id)
                }
            }
        }

        window.addEventListener('message', handleMessage)

        return () => window.removeEventListener('message', handleMessage)
    }, [])

    useEffect(() => {
        const fetchForms = async () => {
            const userId = localStorage.getItem('user_id')
            const processStepId = localStorage.getItem('process_step_id')
            if (!userId || !processStepId) return

            try {
                const response = await fetch(
                    `/api/quality-install?user_id=${userId}&process_step_id=${processStepId}`,
                    {
                        headers: { Authorization: `Bearer ${getAuthToken()}` },
                    },
                )

                const data = await response.json()

                if (data.success && Array.isArray(data.forms)) {
                    window.docDataMap = {}

                    data.forms.forEach((form: FormEntry) => {
                        window.docDataMap[form.id] = form.form_data
                    })

                    const transformed = data.forms.map((form: FormEntry) => ({
                        _id: form.id,
                        metadata_: {
                            doc_name:
                                form.form_data?.installer?.company_name ||
                                'Untitled',
                            form_id: form.id,
                        },
                        data_: form.form_data,
                    }))

                    for (const doc of transformed) {
                        let inserted = false
                        let tries = 0

                        while (!inserted && tries < 3) {
                            try {
                                const existing = await db.get(doc._id)

                                inserted = true
                            } catch (err: any) {
                                if (err.status === 404) {
                                    try {
                                        await db.put(doc)
                                        inserted = true
                                    } catch (putErr: any) {
                                        if (putErr.status === 409) {
                                            console.warn(
                                                `Conflict during initial insert, retrying...`,
                                            )
                                            tries++
                                            continue
                                        } else {
                                            console.error(
                                                'Error putting doc:',
                                                putErr,
                                            )
                                            inserted = true
                                        }
                                    }
                                } else if (err.status === 409) {
                                    console.warn(
                                        `Conflict while checking doc existence, retrying...`,
                                    )
                                    tries++
                                    continue
                                } else {
                                    console.error(
                                        'Unexpected error checking doc existence:',
                                        err,
                                    )
                                    inserted = true
                                }
                            }
                        }

                        if (!inserted) {
                            console.error(
                                `Failed to insert document ${doc._id} after ${tries} attempts.`,
                            )
                        }
                    }

                    setFormEntries(data.forms)
                    setProjectList(transformed)
                }
            } catch (error) {
                console.error('Error fetching or inserting forms:', error)
            }
        }

        fetchForms()
    }, [userId, processStepId])

    useEffect(() => {
        persistSessionState({ userId, applicationId, processId, processStepId })
    }, [userId, applicationId, processId, processStepId])

    useEffect(() => {
        const savedUserId = localStorage.getItem('user_id')
        const savedApplicationId = localStorage.getItem('application_id')
        const savedProcessId = localStorage.getItem('process_id')
        const savedProcessStepId = localStorage.getItem('process_step_id')

        if (savedUserId) setUserId(savedUserId)
        if (savedApplicationId) setApplicationId(savedApplicationId)
        if (savedProcessId) setProcessId(savedProcessId)
        if (savedProcessStepId) setProcessStepId(savedProcessStepId)
    }, [])

    useEffect(() => {
        deleteEmptyProjects(db)
    }, [])

    useEffect(() => {
        if (!db) return
        retrieveProjectInfo()
    }, [db])

    const handleFormSelect = (form: FormEntry | null) => {
        if (!window.docDataMap) window.docDataMap = {}

        if (form) {
            setSelectedFormId(form.id)
            localStorage.setItem('form_id', form.id)

            window.docDataMap[form.id] = form.form_data
            window.docData = form.form_data
        } else {
            setSelectedFormId(null)
            localStorage.removeItem('form_id')
            window.docData = {}
            console.warn('Deselected form or selected form was null')
        }
    }

    // const handleAddJob = async () => {

    //     const { putNewProject } = await import('../utilities/database_utils')
    //     const formId =
    //         prefillFormHardcodedProject(handleFormSelect) || crypto.randomUUID()

    //     if (formId) {
    //         setSelectedFormId(formId)
    //     }

    //     // If form wasn't prefilled, fall back to blank defaults
    //     if (!window.docData || Object.keys(window.docData).length === 0) {
    //         window.docData = {
    //             location: {
    //                 city: '',
    //                 state: '',
    //                 zip_code: '',
    //                 street_address: '',
    //             },
    //             installer: {
    //                 name: '',
    //                 email: '',
    //                 phone: '',
    //                 company_name: '',
    //                 mailing_address: '',
    //             },
    //         }
    //     }

    //     window.docDataMap = window.docDataMap || {}
    //     window.docDataMap[formId] = window.docData

    //     // ✅ This is what makes it actually show up in the UI
    //     await db.upsert(formId, (doc: any) => {
    //         return {
    //             ...doc,
    //             data_: window.docData,
    //             metadata_: {
    //                 ...(doc.metadata_ || {}),
    //                 form_id: formId,
    //             },
    //         }
    //     })

    //     const newProjectDoc = await putNewProject(db, '', formId)
    //     if (newProjectDoc) {
    //         await retrieveProjectInfo()
    //         editAddressDetailsDirect(newProjectDoc.id, formId)
    //     }
    // }
    const handleAddJob = async () => {
        const { putNewProject } = await import('../utilities/database_utils')
        const formId = crypto.randomUUID()

        const formData = {
            selectedProgram: 'HEAR',
            location: {
                street_address: '2001 East Dixon Boulevard',
                city: 'Shelby',
                state: 'NC',
                zip_code: '28152',
            },
            installer: {
                name: 'maxine meurer',
                email: 'maxine@everblue.com',
                phone: '9999999999',
                company_name: 'Everblue Energy',
                mailing_address: '1234 Main St, Shelby, NC',
            },
        }

        window.docData = formData
        window.docDataMap = window.docDataMap || {}
        window.docDataMap[formId] = formData

        await db.upsert(formId, (doc: any) => ({
            ...doc,
            data_: formData,
            metadata_: {
                ...(doc.metadata_ || {}),
                form_id: formId,
            },
        }))

        handleFormSelect({
            id: formId,
            form_data: formData,
            user_id: 'f46c6d3f-658b-45d8-b146-d2fa985233c7',
            process_step_id: '6a92a670-f953-47e2-8ac5-545746b3d244',
            created_at: new Date().toISOString(),
            updated_at: null,
        })

        setSelectedFormId(formId)

        const newProjectDoc = await putNewProject(db, '', formId)
        if (newProjectDoc) {
            await retrieveProjectInfo()
            editAddressDetailsDirect(newProjectDoc.id, formId)
        }
    }

    const handleDeleteJob = (docId: string) => {
        setSelectedProjectToDelete(docId)
        setShowDeleteConfirmation(true)
    }

    const confirmDeleteJob = async () => {
        try {
            if (!selectedProjectToDelete) {
                console.warn('No project selected to delete.')
                return
            }
            const projectDoc: any = await db.get(selectedProjectToDelete)

            const response = await fetch(
                `http://localhost:5000/api/quality-install/${selectedProjectToDelete}`,
                {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${getAuthToken()}` },
                },
            )

            if (!response.ok) {
                console.error('Failed to delete form from backend')
            } else {
                console.log('Deleted form from vapor-core successfully')
            }

            if (projectDoc?.children?.length > 0) {
                const installDocs = await db.allDocs({
                    keys: projectDoc.children,
                    include_docs: true,
                })

                const docsToDelete = installDocs.rows
                    .filter((row: { doc: any }) => !!row.doc)
                    .map((row: { doc: { _id: any; _rev: any } }) => ({
                        _id: row.doc._id,
                        _rev: row.doc._rev,
                        _deleted: true,
                    }))

                if (docsToDelete.length > 0) {
                    console.log(
                        'Deleting child installation docs:',
                        docsToDelete,
                    )
                    await db.bulkDocs(docsToDelete)
                }
            }

            await db.remove(projectDoc)

            setProjectList(prev =>
                prev.filter(p => p._id !== selectedProjectToDelete),
            )
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

    const editAddressDetailsDirect = (projectID: string, formId: string) => {
        const selectedForm: FormEntry = {
            id: formId,
            user_id: userId!,
            process_step_id: processStepId!,
            form_data: window.docData,
            created_at: new Date().toISOString(),
            updated_at: null,
        }

        localStorage.setItem('form_id', formId)
        handleFormSelect(selectedForm)
        navigate('app/' + projectID, { replace: true })
    }

    const editAddressDetails = async (projectID: string) => {
        const matchingProject = projectList.find(
            project => project._id === projectID,
        )
        const formId = matchingProject?.metadata_?.form_id

        if (!formId) {
            console.error('Form ID not found for project:', projectID)
            return
        }

        const selectedForm = formEntries.find(form => form.id === formId)

        if (selectedForm) {
            localStorage.setItem('form_id', formId)
            await new Promise(resolve => setTimeout(resolve, 50)) 
            handleFormSelect(selectedForm)
            setSelectedFormId(formId)
        }
    }

    const projects_display =
        Object.keys(projectList).length === 0
            ? []
            : projectList.map(project => (
                  <div key={project._id}>
                      <ListGroup className="padding">
                          <LinkContainer to={`/app/${project._id}/workflows`}>
                              <ListGroup.Item
                                  action={true}
                                  onClick={() =>
                                      editAddressDetails(project._id)
                                  }
                              >
                                  <span className="icon-container">
                                      {/* <Menu options={options} /> */}

                                      <Button
                                          variant="light"
                                          onClick={async event => {
                                              event.stopPropagation()
                                              event.preventDefault()
                                              await editAddressDetails(
                                                  project._id,
                                              )
                                              navigate(`/app/${project._id}`)
                                          }}
                                      >
                                          <TfiPencil size={22} />
                                      </Button>

                                      <Button
                                          variant="light"
                                          onClick={event =>
                                              handleDelete(event, project)
                                          }
                                      >
                                          <TfiTrash size={22} />
                                      </Button>
                                      <ExportDoc
                                          docId={project._id}
                                          docName={project.metadata_?.doc_name}
                                          includeChild={true}
                                      />
                                  </span>
                                  <b>{project.metadata_?.doc_name}</b>
                                  {project.data_?.location?.street_address && (
                                      <>
                                          <br />
                                          {
                                              project.data_?.location
                                                  ?.street_address
                                          }
                                          ,
                                      </>
                                  )}
                                  {project.data_?.location?.city && (
                                      <>
                                          <br />
                                          {project.data_?.location?.city},{' '}
                                      </>
                                  )}
                                  {project.data_.location?.state && (
                                      <>{project.data_?.location?.state} </>
                                  )}
                                  {project.data_.location?.zip_code && (
                                      <>{project.data_?.location?.zip_code}</>
                                  )}
                              </ListGroup.Item>
                          </LinkContainer>
                      </ListGroup>
                  </div>
              ))

    return projectList.length > 0 || selectedProjectToDelete ? (
        <StoreProvider
            dbName="db"
            docId={selectedFormId || ''}
            workflowName=""
            docName={
                selectedProjectToDelete
                    ? projectList.find(p => p._id === selectedProjectToDelete)
                          ?.metadata_?.doc_name || ''
                    : projectList[0]?.metadata_?.doc_name || ''
            }
            type="project"
            parentId={undefined}
            userId={userId}
            applicationId={applicationId}
            processId={processId}
            processStepId={processStepId}
            selectedFormId={selectedFormId}
            setSelectedFormId={setSelectedFormId}
            handleFormSelect={handleFormSelect}
            formEntries={formEntries}
            s3Config={s3Config}
        >
            <>
                <div>
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
                                    Add a New Project
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
                            <div className="align-right padding">
                                <Button
                                    onClick={handleAddJob}
                                    alt-text="Add a New Project"
                                >
                                    Add a New Project
                                </Button>
                                <ImportDoc
                                    id="project_json"
                                    label="Import Project"
                                />
                            </div>
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
                        <b>{selectedProjectNameToDelete}</b>? This action cannot
                        be undone.
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
        </StoreProvider>
    ) : (
        <div>Loading...</div>
    )
}

export default Home
