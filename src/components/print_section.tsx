import { useId, useState, FC, ReactNode } from 'react'
import print from 'print-js'
import Button from 'react-bootstrap/Button'
import jsPDF from 'jspdf'
import { uploadImageToS3AndCreateDocument } from '../utilities/s3_utils'

interface PrintSectionProps {
    children: ReactNode
    label: string
    // documentType: string
}

/**
 * Component with a print button for printing the component's child content
 *
 * @param children Content for printing
 * @param label Label for the print button
 */
const PrintSection: FC<PrintSectionProps> = ({
    children,
    label,
    // documentType,
}) => {
    const [isSubmitted, setIsSubmitted] = useState(false)
    const [isUploading, setIsUploading] = useState(false)

    const userId = localStorage.getItem('user_id')
    const organizationId = localStorage.getItem('organization_id')
    const documentType = 'Quality Install Document' // pass this down? not sure yet

    const printContainerId = useId()
    const isSafari = () =>
        /^((?!chrome|android).)*safari/i.test(navigator.userAgent)

    const addSafariHeader = () => {
        if (isSafari()) {
            const printWrapper = document.getElementById(printContainerId)
            if (printWrapper) {
                const header = document.createElement('div')
                header.className = 'safari-print-header'
                header.innerText = 'DOE - Quality Installation Report' // Customize your header text
                printWrapper.prepend(header) // Add header at the top
            }
        }
    }

    const handleSubmitReport = async () => {
        setIsUploading(true)

        const container = document.getElementById(printContainerId)
        if (!container) throw new Error('Container ID not found!')

        try {
            const doc = new jsPDF({
                orientation: 'portrait',
                unit: 'pt',
                format: 'a4',
            })

            doc.html(container, {
                x: 10,
                y: 10,
                autoPaging: 'text',
                html2canvas: {
                    scale: 1,
                    allowTaint: true,
                    useCORS: true,
                },
                callback: async function (doc) {
                    const pdfBlob = doc.output('blob')

                    const documentId = await uploadImageToS3AndCreateDocument({
                        file: pdfBlob,
                        userId,
                        organizationId,
                        documentType,
                    })

                    if (documentId) {
                        alert('Report submitted Successfully!')
                        setIsSubmitted(true)
                    }
                },
            })
        } catch (error) {
            console.error('Failed to generate and submit report: ', error)
            alert('Submission failed. Please try again.')
        } finally {
            setIsUploading(false)
        }
    }

    return (
        <>
            {!isSubmitted ? (
                <Button
                    onClick={handleSubmitReport}
                    disabled={isUploading}
                    variant="success"
                >
                    {isUploading ? 'Submitting...' : 'Submit Final Report'}
                </Button>
            ) : (
                <Button
                    onClick={event => {
                        addSafariHeader()
                        print({
                            maxWidth: 2000,
                            printable: printContainerId,
                            onPrintDialogClose: () => {
                                document.title = 'Quality Install Tool'
                            },
                            type: 'html',
                            targetStyles: ['*'],
                            css: ['/bootstrap.min.css', '/print.css'],
                            documentTitle: 'DOE - Quality Installation Report',
                            scanStyles: false,
                        })
                    }}
                    variant="primary"
                >
                    {label}
                </Button>
            )}

            <div id={printContainerId}>
                <div className="print-wrapper">{children}</div>
            </div>
        </>
    )
}

export default PrintSection
