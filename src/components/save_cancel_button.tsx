import { FC, useEffect, useState } from 'react'
import { Button } from 'react-bootstrap'
import type { MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDB } from '../utilities/database_utils'
import { uploadImageToS3AndCreateDocument } from '../utilities/s3_utils'
import { saveProjectToRDS } from './store'

interface SaveCancelButtonProps {
    id: string
    value: string
    updateValue: (inputValue: string) => void
    doc_status: string
}

/**
 * A component that provides "Save" and "Cancel" buttons for managing project doc in DB.
 *
 * The component handles saving the project, showing a confirmation dialog for
 * canceling unsaved changes, and deleting an empty project if necessary.
 * It also manages the button states based on the document status and updates
 * the UI accordingly.
 *
 * @param id - The unique identifier for the project document.
 * @param updateValue - Function to update the document status.
 * @param doc_status - Current status of the document.
 * @returns The rendered component.
 */
const SaveCancelButton: FC<SaveCancelButtonProps> = ({
    id,
    value,
    updateValue,
    doc_status,
}) => {
    const navigate = useNavigate()
    const [disableSave, setDisableSave] = useState<boolean>(true)
    const [docStatus, setDocStatus] = useState<string>(doc_status)
    const [docName, setDocName] = useState<string>()
    const [buttonLabel, setButtonLabel] = useState<String>('Save Project')
    const db = useDB()

    const handleCancelButtonClick = async (
        event: MouseEvent<HTMLButtonElement>,
    ) => {
        if (docStatus === 'created') {
            navigate('/', { replace: true })
            return
        }

        navigate('/', { replace: true })

        // deleteEmptyProject()
    }

    const handleSaveClick = async () => {
        try {
            const projectDoc: any = await db.get(id)

            if (!projectDoc.metadata_ || !projectDoc.metadata_.doc_name) {
                alert('Please enter a project name before saving.')
                return
            }

            // upload photo attachments to S3 and replace metadata
            if (projectDoc._attachments && projectDoc.metadata_?.attachments) {
                const updatedMetadata = { ...projectDoc.metadata_ }

                for (const attachmentId of Object.keys(
                    projectDoc._attachments,
                )) {
                    const existing =
                        projectDoc.metadata_?.attachments?.[attachmentId]
                    if (existing?.documentId) continue // skip if already uploaded

                    const blob = await db.getAttachment(id, attachmentId)

                    // Extract geolocation BEFORE upload so it can be stored in vapor-core
                    const { getMetadataFromPhoto } = await import(
                        '../utilities/photo_utils'
                    )
                    const photoMetadata = await getMetadataFromPhoto(blob)

                    // Extract photo label and index from attachmentId (e.g., "existing_ductwork_photo_0")
                    const indexMatch = attachmentId.match(/_(\d+)$/)
                    const photoIndex = indexMatch
                        ? parseInt(indexMatch[1], 10)
                        : 0
                    // Remove the trailing _0, _1, etc. to get the base label
                    const photoLabel = attachmentId.replace(/_\d+$/, '')

                    const documentId = await uploadImageToS3AndCreateDocument({
                        file: blob,
                        userId: localStorage.getItem('user_id'),
                        organizationId: localStorage.getItem('organization_id'),
                        applicationId: localStorage.getItem('application_id'),
                        documentType: 'Quality Install Photo',
                        measureName:
                            projectDoc.metadata_?.doc_name || 'unknown',
                        geolocation: photoMetadata?.geolocation,
                        photoLabel,
                        photoIndex,
                    })

                    updatedMetadata.attachments[attachmentId] = {
                        ...photoMetadata,
                        documentId,
                        timestamp: new Date().toISOString(),
                    }
                }

                // persist the updated metadata back to PouchDB
                await db.put({
                    ...projectDoc,
                    _rev: projectDoc._rev,
                    metadata_: updatedMetadata,
                    type: 'project',
                })
            }

            // send the full form data to RDS
            const updatedDoc = await db.get(id)

            const formData = {
                metadata_: updatedDoc.metadata_,
                data_: updatedDoc.data_,
                type: 'project',
                docId: id,
            }

            // Log what's being saved for debugging
            const attachmentsInfo = updatedDoc.metadata_?.attachments || {}
            console.log('[SAVE TO RDS] Saving project with attachments:', {
                docId: id,
                attachmentCount: Object.keys(attachmentsInfo).length,
                attachmentsWithDocumentId: Object.entries(attachmentsInfo)
                    .filter(([_, meta]: [string, any]) => meta?.documentId)
                    .map(([key, meta]: [string, any]) => ({
                        key,
                        documentId: meta.documentId,
                    })),
                dataKeys: Object.keys(updatedDoc.data_ || {}),
            })

            await saveProjectToRDS({
                userId: localStorage.getItem('user_id')!,
                processStepId: localStorage.getItem('process_step_id')!,
                formData,
                docId: id,
                applicationId: localStorage.getItem('application_id')!,
            })

            console.log('[SAVE TO RDS] Project saved successfully')
            updateValue('created')
            navigate('/', { replace: true })
        } catch (error) {
            console.error('Error saving project with attachments:', error)
            alert('Save failed. See console for details.')
        }
    }

    useEffect(() => {
        checkProjectDocName()
        db.changes({
            since: 'now',
            live: true,
        }).on('change', checkProjectDocName)
    }, [])

    const checkProjectDocName = async () => {
        try {
            if (docStatus !== 'deleted') {
                const projectDoc: any = await db.get(id)
                if (projectDoc && projectDoc.metadata_?.doc_name) {
                    setDisableSave(false)
                    if (!docName) setDocName(projectDoc.metadata_?.doc_name)
                }
            }
        } catch (error) {}
    }

    const deleteEmptyProject = async () => {
        try {
            if (docStatus === 'new') {
                const projectDoc: any = await db.get(id)
                if (projectDoc) {
                    db.remove(projectDoc)
                    setDocStatus('deleted')
                }
            }
        } catch (error) {
            console.error('Error in discarding the empty project:', error)
        } finally {
            navigate('/', { replace: true })
        }
    }

    return (
        <center>
            <div>
                <Button variant="secondary" onClick={handleCancelButtonClick}>
                    Cancel
                </Button>{' '}
                &nbsp;
                <Button
                    variant="primary"
                    onClick={handleSaveClick}
                    disabled={disableSave}
                >
                    {buttonLabel}
                </Button>
            </div>
        </center>
    )
}

export default SaveCancelButton
