import { useId, useState, FC, ReactNode, useEffect } from 'react'
import print from 'print-js'
import Button from 'react-bootstrap/Button'
// eslint-disable-next-line
import html2pdf from 'html2pdf.js'
import { PDFDocument } from 'pdf-lib'
import { uploadImageToS3AndCreateDocument } from '../utilities/s3_utils'
import { useDB } from '../utilities/database_utils'
import {
    closeProcessStepIfAllMeasuresComplete,
    updateProcessStepWithMeasure,
} from './store'
import { getConfig } from '../config'

interface PrintSectionProps {
    children: ReactNode
    label: string
    measureName: string
    jobId?: string
}

/**
 * Removes blank pages from a PDF blob using pdf-lib
 */
const removeBlankPagesFromPDF = async (pdfBlob: Blob): Promise<Blob> => {
    try {
        // Load the PDF document
        const pdfBytes = await pdfBlob.arrayBuffer()
        const pdfDoc = await PDFDocument.load(pdfBytes)

        const pages = pdfDoc.getPages()
        const pagesToRemove: number[] = []

        // Simple heuristic: remove the last page if it appears to be blank
        // This is based on the observation that html2pdf often creates a blank last page
        if (pages.length > 1) {
            const lastPage = pages[pages.length - 1]
            const { width, height } = lastPage.getSize()

            // Check if the last page is suspiciously small or empty
            // This is a simplified check - in practice, blank pages from html2pdf
            // often have minimal content
            const isLikelyBlank = await isPageLikelyBlank(
                lastPage,
                width,
                height,
            )

            if (isLikelyBlank) {
                pagesToRemove.push(pages.length - 1)
                console.log(`Removing likely blank last page`)
            }
        }

        // Remove identified blank pages
        if (pagesToRemove.length > 0) {
            pagesToRemove.forEach(pageIndex => {
                pdfDoc.removePage(pageIndex)
            })

            // Save the modified PDF
            const modifiedPdfBytes = await pdfDoc.save()
            return new Blob([modifiedPdfBytes], { type: 'application/pdf' })
        }

        return pdfBlob
    } catch (error) {
        console.warn('Could not remove blank pages from PDF:', error)
        return pdfBlob
    }
}

/**
 * Determines if a PDF page is likely blank using simple heuristics
 */
const isPageLikelyBlank = async (
    page: any,
    width: number,
    height: number,
): Promise<boolean> => {
    try {
        // Get the page's content stream if available
        const operators = page.node?.operators || []

        // If we have very few operators, the page is likely blank
        if (operators.length < 5) {
            return true
        }

        // Check for common content indicators
        const hasContent = operators.some((op: any) => {
            const operator = op.operator || op.fn || ''
            return (
                operator.includes('Tj') || // Text
                operator.includes('Do') || // Images/objects
                operator.includes('re') || // Rectangles
                operator.includes('l') || // Lines
                operator.includes('c')
            ) // Curves
        })

        return !hasContent
    } catch (error) {
        console.warn('Error checking if page is likely blank:', error)
        // If we can't determine, assume it's not blank to be safe
        return false
    }
}

/**
 * Ensures all images in the container are fully loaded before PDF generation
 */
const ensureAllImagesLoaded = async (container: HTMLElement): Promise<void> => {
    const images = container.querySelectorAll('img')
    const imagePromises: Promise<void>[] = []

    images.forEach(img => {
        if (img.complete) {
            console.log('Image already loaded:', img.src)
            return
        }

        const promise = new Promise<void>(resolve => {
            img.onload = () => {
                console.log('Image loaded successfully:', img.src)
                resolve()
            }
            img.onerror = () => {
                console.warn('Image failed to load:', img.src)
                resolve() // Continue even if image fails to load
            }
        })
        imagePromises.push(promise)
    })

    if (imagePromises.length > 0) {
        console.log(`Waiting for ${imagePromises.length} images to load...`)
        // Wait for all images to load with a timeout
        await Promise.race([
            Promise.all(imagePromises),
            new Promise(resolve => setTimeout(resolve, 5000)), // 5 second timeout
        ])
        console.log('Image loading complete')
    } else {
        console.log('No images to load')
    }
}

/**
 * Adds minimal strategic page breaks to prevent content cutoff
 */
const addStrategicPageBreaks = (container: HTMLElement): void => {
    // Only add page breaks for very large content
    const largeContentSelectors = ['h1', '.photo-card']

    largeContentSelectors.forEach(selector => {
        const elements = container.querySelectorAll(selector)
        elements.forEach(element => {
            const elementStyle = (element as HTMLElement).style

            // Add page break before very large photo cards only
            if (element.classList.contains('photo-card')) {
                const rect = element.getBoundingClientRect()
                if (rect.height > 600) {
                    // Only for very large cards
                    elementStyle.pageBreakBefore = 'always'
                    elementStyle.breakBefore = 'page'
                }
            }
        })
    })
}

/**
 * Pre-processes images in the PDF container to improve quality and fix metadata cutoff
 */
const preprocessImagesForPDF = (container: HTMLElement) => {
    const images = container.querySelectorAll('img')
    images.forEach(img => {
        // Ensure images are loaded at maximum quality
        img.style.imageRendering = 'high-quality'
        img.style.imageRendering = '-webkit-optimize-contrast'
        img.style.imageRendering = 'crisp-edges'

        // Remove any constraints that might limit quality
        img.style.maxWidth = 'none'
        img.style.maxHeight = 'none'
        img.style.minWidth = 'none'
        img.style.minHeight = 'none'

        // Set optimal dimensions for PDF while preserving quality
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            const aspectRatio = img.naturalWidth / img.naturalHeight
            const maxWidth = 500 // Increased maximum width in points for PDF
            const maxHeight = 400 // Increased maximum height in points for PDF

            if (aspectRatio > maxWidth / maxHeight) {
                img.style.width = `${maxWidth}pt`
                img.style.height = 'auto'
            } else {
                img.style.width = 'auto'
                img.style.height = `${maxHeight}pt`
            }
        }

        // Ensure images are fully loaded before PDF generation
        if (!img.complete) {
            img.style.opacity = '0'
            img.onload = () => {
                img.style.opacity = '1'
            }
        }

        // Force high-quality rendering
        img.style.objectFit = 'contain'
        img.style.objectPosition = 'center'
    })

    // Fix photo containers to prevent metadata cutoff
    const photoContainers = container.querySelectorAll(
        '.photo-report-container',
    )
    photoContainers.forEach(container => {
        const containerElement = container as HTMLElement
        // Remove all height and overflow restrictions
        containerElement.style.maxHeight = 'none'
        containerElement.style.height = 'auto'
        containerElement.style.overflow = 'visible'
        containerElement.style.overflowX = 'visible'
        containerElement.style.overflowY = 'visible'
        containerElement.style.marginBottom = '25px'
        containerElement.style.paddingBottom = '10px'
        containerElement.style.pageBreakInside = 'avoid'
        containerElement.style.display = 'block'
        containerElement.style.width = 'auto'
        containerElement.style.maxWidth = '250px'
    })

    // Fix metadata text containers (the div wrapping the small elements)
    const metadataContainers = container.querySelectorAll(
        '.photo-report-container > div',
    )
    metadataContainers.forEach(container => {
        const containerElement = container as HTMLElement
        containerElement.style.overflow = 'visible'
        containerElement.style.maxHeight = 'none'
        containerElement.style.height = 'auto'
        containerElement.style.marginTop = '8px'
        containerElement.style.marginBottom = '0'
        containerElement.style.padding = '0'
    })

    // Ensure metadata text is properly sized and visible
    const metadataTexts = container.querySelectorAll(
        '.photo-report-container small',
    )
    metadataTexts.forEach(text => {
        const textElement = text as HTMLElement
        textElement.style.fontSize = '9px'
        textElement.style.lineHeight = '1.3'
        textElement.style.marginTop = '5px'
        textElement.style.marginBottom = '0'
        textElement.style.display = 'block'
        textElement.style.wordWrap = 'break-word'
        textElement.style.overflowWrap = 'break-word'
        textElement.style.whiteSpace = 'normal'
        textElement.style.overflow = 'visible'
        textElement.style.maxHeight = 'none'
        textElement.style.height = 'auto'
        textElement.style.color = '#333'
        textElement.style.fontWeight = 'normal'
    })

    // Fix photo rows to ensure proper spacing
    const photoRows = container.querySelectorAll('.photo-row')
    photoRows.forEach(row => {
        const rowElement = row as HTMLElement
        rowElement.style.gap = '20px'
        rowElement.style.alignItems = 'start'
        rowElement.style.marginBottom = '0'
    })

    // Fix photo cards to ensure proper spacing
    const photoCards = container.querySelectorAll('.photo-card')
    photoCards.forEach(card => {
        const cardElement = card as HTMLElement
        cardElement.style.overflow = 'visible'
        cardElement.style.maxHeight = 'none'
        cardElement.style.marginBottom = '30px'
        cardElement.style.pageBreakInside = 'avoid'
        cardElement.style.breakInside = 'avoid'
    })

    // Add minimal page break controls to prevent content cutoff
    const allElements = container.querySelectorAll('*')
    allElements.forEach(element => {
        const elementStyle = (element as HTMLElement).style

        // Prevent page breaks inside important content
        if (
            element.tagName === 'H1' ||
            element.tagName === 'H2' ||
            element.tagName === 'H3'
        ) {
            elementStyle.pageBreakAfter = 'avoid'
            elementStyle.breakAfter = 'avoid'
        }

        // Prevent page breaks inside cards and containers
        if (
            element.classList.contains('card') ||
            element.classList.contains('photo-card') ||
            element.classList.contains('photo-report-container')
        ) {
            elementStyle.pageBreakInside = 'avoid'
            elementStyle.breakInside = 'avoid'
        }

        // Ensure proper spacing around images
        if (element.tagName === 'IMG') {
            elementStyle.pageBreakInside = 'avoid'
            elementStyle.breakInside = 'avoid'
        }

        // Prevent orphaned text
        if (element.tagName === 'P' || element.tagName === 'DIV') {
            elementStyle.orphans = '3'
            elementStyle.widows = '3'
        }

        // Add spacing for lists
        if (element.tagName === 'UL' || element.tagName === 'OL') {
            elementStyle.pageBreakInside = 'avoid'
            elementStyle.breakInside = 'avoid'
        }

        // Ensure tables don't break across pages
        if (element.tagName === 'TABLE') {
            elementStyle.pageBreakInside = 'avoid'
            elementStyle.breakInside = 'avoid'
        }
    })

    // Clean up extra space and padding that might cause blank pages
    const containerElement = container as HTMLElement
    containerElement.style.paddingBottom = '0'
    containerElement.style.marginBottom = '0'

    // Remove any trailing empty elements that might cause blank pages
    const lastChild = container.lastElementChild
    if (lastChild) {
        const lastChildElement = lastChild as HTMLElement
        // Remove excessive bottom margin/padding from last element
        lastChildElement.style.marginBottom = '0'
        lastChildElement.style.paddingBottom = '0'

        // If the last element is empty or just whitespace, remove it
        if (
            lastChildElement.textContent?.trim() === '' &&
            lastChildElement.children.length === 0
        ) {
            lastChildElement.remove()
        }
    }

    // Add strategic page breaks for large content
    addStrategicPageBreaks(container)
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
    measureName,
    jobId,
}) => {
    const [existingMeasure, setExistingMeasure] = useState<any | null>(null)
    const [isSubmitted, setIsSubmitted] = useState(false)
    const [submissionStatus, setSubmissionStatus] = useState<
        'idle' | 'success' | 'error'
    >('idle')

    const [isUploading, setIsUploading] = useState(false)

    const db = useDB()
    const docId = localStorage.getItem('selected_doc_id')
    const userId = localStorage.getItem('user_id')
    const processId = localStorage.getItem('process_id')
    const processStepId = localStorage.getItem('process_step_id')
    const organizationId = localStorage.getItem('organization_id')
    const applicationId = localStorage.getItem('application_id')
    const documentType = 'Quality Install Document'

    const printContainerId = useId()
    const isSafari = () =>
        /^((?!chrome|android).)*safari/i.test(navigator.userAgent)

    const REACT_APP_VAPORCORE_URL = getConfig('REACT_APP_VAPORCORE_URL')

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

    // option to update existing submission if found
    useEffect(() => {
        const checkExistingSubmission = async () => {
            if (!processId || !processStepId || !userId) return

            try {
                const res = await fetch(
                    `${REACT_APP_VAPORCORE_URL}/api/process/${processId}/step/${processStepId}/form-data?user_id=${userId}`,
                    {
                        method: 'GET',
                    },
                )

                const data = await res.json()
                const measures = data?.data?.measures || []

                const found = measures.find(
                    (m: any) =>
                        m.name === measureName &&
                        m.status?.toLowerCase() === 'completed',
                )

                if (found) {
                    setExistingMeasure(found)
                    setIsSubmitted(true)
                }
            } catch (err) {
                console.error('Error checking existing submission:', err)
            }
        }

        checkExistingSubmission()
    }, [processId, processStepId, userId, measureName])

    const handleSubmitReport = async () => {
        setIsUploading(true)
        setSubmissionStatus('idle')

        const container = document.getElementById(printContainerId)
        if (!container) {
            alert('Error: Print container not found.')
            setIsUploading(false)
            return
        }

        let vaporCoreDocumentId: string | undefined
        let response: any

        try {
            // generate PDF from final report data
            const container = document.getElementById(printContainerId)
            if (!container) {
                alert('Error: Print container not found.')
                return
            }

            const wrapper = container.querySelector('.pdf-wrapper')
            if (!wrapper) {
                alert('Error: .pdf-wrapper not found inside container.')
                return
            }
            // preprocess images for better PDF quality
            preprocessImagesForPDF(wrapper as HTMLElement)

            // ensure all images are fully loaded before PDF generation
            await ensureAllImagesLoaded(wrapper as HTMLElement)

            const opt = {
                margin: [20, 20, 20, 20], // Balanced margins
                filename: 'report.pdf',
                image: {
                    type: 'jpeg',
                    quality: 1.0, // Maximum quality
                },
                html2canvas: {
                    scale: 2.5, // Increased to 2.5 for better quality
                    useCORS: true,
                    logging: true,
                    allowTaint: true, // Allow cross-origin images
                    imageTimeout: 20000, // Increased timeout for higher quality
                    letterRendering: true, // Better text rendering
                    removeContainer: true, // Remove container after processing
                    backgroundColor: '#ffffff', // Ensure white background
                    foreignObjectRendering: false, // Keep disabled for stability
                    imageRendering: 'high-quality', // High-quality image rendering
                },
                jsPDF: {
                    unit: 'pt',
                    format: 'a4',
                    orientation: 'portrait',
                    compress: false, // Disable PDF compression for better image quality
                    putOnlyUsedFonts: true, // Optimize font usage
                    autoPaging: 'text', // Better text flow
                    precision: 16, // High precision for better quality
                },
                pagebreak: {
                    mode: ['css', 'legacy'], // Removed 'avoid-all' which was causing issues
                    before: '.page-break-before',
                    after: '.page-break-after',
                    avoid: '.page-break-avoid',
                },
            }

            const pdfBlob = await html2pdf()
                .set(opt)
                .from(wrapper)
                .output('blob')

            // post-process PDF to remove blank pages
            const cleanedPdfBlob = await removeBlankPagesFromPDF(pdfBlob)

            // create document ID in vapor-core, upload to S3
            vaporCoreDocumentId = await uploadImageToS3AndCreateDocument({
                file: cleanedPdfBlob,
                userId,
                applicationId,
                organizationId,
                documentType,
                measureName,
            })

            if (!vaporCoreDocumentId) {
                throw new Error('Upload to S3 failed')
            }
            // update process step with measure info
            await updateProcessStepWithMeasure({
                userId: userId,
                processId: processId!,
                processStepId: processStepId!,
                measureName,
                finalReportDocumentId: vaporCoreDocumentId,
                jobId: jobId,
            })

            // send postMessage request back up to vapor-flow
            // used to render finalized report data in the UI
            const reportData = {
                type: 'FINAL_REPORT_SUBMITTED',
                payload: {
                    applicationId: applicationId,
                    measureName: measureName,
                    finalReportDocumentId: vaporCoreDocumentId,
                },
            }

            window.parent.postMessage(reportData, '*')

            // update process step to CLOSED if all measures complete
            await closeProcessStepIfAllMeasuresComplete(
                processId,
                processStepId,
                userId,
            )

            setIsSubmitted(true)
            setSubmissionStatus('success')
        } catch (error) {
            console.error('Submission failed:', error)
            alert('Submission failed. Please try again.')
            setSubmissionStatus('error')
        } finally {
            setIsUploading(false)
        }
    }

    return (
        <>
            {(existingMeasure || !isSubmitted) && (
                <Button
                    onClick={handleSubmitReport}
                    disabled={isUploading}
                    variant={existingMeasure ? 'warning' : 'success'}
                    style={{ marginRight: '1rem' }}
                >
                    {isUploading
                        ? existingMeasure
                            ? 'Updating...'
                            : 'Submitting...'
                        : existingMeasure
                          ? 'Update Submission'
                          : 'Submit Final Report'}
                </Button>
            )}

            {(isSubmitted || existingMeasure) && (
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

            {submissionStatus === 'success' && (
                <p style={{ color: 'green', marginTop: '1rem' }}>
                    Report submitted successfully!
                </p>
            )}

            {submissionStatus === 'error' && (
                <p style={{ color: 'red', marginTop: '1rem' }}>
                    There was an error submitting the report.
                </p>
            )}

            <div id={printContainerId}>
                <div className="avoid-page-breaks">{children}</div>
            </div>
        </>
    )
}

export default PrintSection
