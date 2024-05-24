import { useState, type FC, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import dbName from './db_details'
import { StoreProvider } from './store'
import MdxWrapper from './mdx_wrapper'
import templatesConfig from '../templates/templates_config'
import {
    retrieveProjectSummary,
    retrieveDocFromDB,
} from '../utilities/database_utils'
import PouchDB from 'pouchdb'
import { toNumber } from 'lodash'
import { ListGroup } from 'react-bootstrap'

/**
 * A component view of an instantiated MDX template
 *
 * @remarks
 * The installation ID (or jobID) for the instance is taken from a dynamic segment
 * of the route, :jobId.
 *
 * @param workflowName - The name associated with an MDX template
 * @param project - The parent doc object that holds the installation information
 */
const MdxTemplateView: FC = () => {
    const { jobId, projectId, workflowName } = useParams()
    const config = templatesConfig[workflowName as string]

    const [project, setProject] = useState<any>({})
    const [projectSummary, setProjectSummary] = useState<any>({})
    const [installationInfo, setInstallationInfo] = useState<any>({})

    const project_info = async (): Promise<void> => {
        retrieveProjectSummary(
            new PouchDB(dbName),
            projectId as string,
            workflowName as string,
        ).then((res: any) => {
            setProjectSummary(res)
        })
    }

    const retrieveInstallationsInfo = async (): Promise<void> => {
        retrieveDocFromDB(new PouchDB(dbName), jobId as string).then(
            (res: any) => {
                setInstallationInfo(res)
            },
        )
        retrieveDocFromDB(new PouchDB(dbName), projectId as string).then(
            (res: any) => {
                setProject(res)
            },
        )
    }

    useEffect(() => {
        project_info()
        retrieveInstallationsInfo()
    }, [])

    const doc_name = installationInfo?.metadata_?.doc_name

    return (
        <StoreProvider
            dbName={dbName}
            docId={jobId as string}
            workflowName={workflowName as string}
            docName={doc_name}
            type={'installation'}
            parentId={projectId as string}
        >
            <h1>{projectSummary?.installation_name}</h1>
            <h2>Installation for {projectSummary?.project_name}</h2>
            <ListGroup className="address">
                {projectSummary?.street_address}
                {projectSummary?.city}
                {projectSummary?.state}
                {projectSummary?.zip_code}
            </ListGroup>
            <center>
                <b>{doc_name}</b>
            </center>
            <br />
            <MdxWrapper Component={config.template} Project={project} />
        </StoreProvider>
    )
}

export default MdxTemplateView
