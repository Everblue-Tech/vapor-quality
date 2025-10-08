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
                console.log(
                    `Removing likely blank last page (page ${pages.length})`,
                )
            } else {
                console.log(`Last page appears to have content, keeping it`)
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

        // More conservative: require fewer operators to be considered non-blank
        if (operators.length < 3) {
            return true
        }

        // Count content operators more carefully
        let contentCount = 0
        operators.forEach((op: any) => {
            const operator = op.operator || op.fn || ''
            if (
                operator.includes('Tj') || // Text
                operator.includes('Do') || // Images/objects
                operator.includes('re') || // Rectangles
                operator.includes('l') || // Lines
                operator.includes('c') || // Curves
                operator.includes('m') || // Move to
                operator.includes('f') || // Fill
                operator.includes('S') // Stroke
            ) {
                contentCount++
            }
        })

        // Page is blank if it has very little content
        return contentCount < 2
    } catch (error) {
        console.warn('Error checking if page is likely blank:', error)
        // If we can't determine, assume it's not blank to be safe
        return false
    }
}

/**
 * Breaks up large content into manageable chunks for PDF generation
 */
const chunkContentForPDF = (container: HTMLElement): HTMLElement[] => {
  const chunks: HTMLElement[] = []
  const maxChunkHeight = 2000 // Maximum height per chunk in pixels
  const children = Array.from(container.children) as HTMLElement[]

  // If there are no children, return the container as a single chunk
  if (children.length === 0) {
    const singleChunk = document.createElement('div')
    singleChunk.className = 'pdf-chunk'
    singleChunk.innerHTML = container.innerHTML
    chunks.push(singleChunk)
    return chunks
  }

  let currentChunk: HTMLElement | null = null
  let currentChunkHeight = 0

  children.forEach((child, index) => {
    // Get the actual height of the child element
    const childHeight = Math.max(
      child.offsetHeight || 0,
      child.scrollHeight || 0,
      child.clientHeight || 0,
    )

    // If this child would exceed the max height and we have a current chunk, start a new chunk
    if (currentChunkHeight + childHeight > maxChunkHeight && currentChunk) {
      chunks.push(currentChunk)
      currentChunk = null
      currentChunkHeight = 0
    }

    // Create a new chunk if we don't have one
    if (!currentChunk) {
      currentChunk = document.createElement('div')
      currentChunk.className = 'pdf-chunk'
      currentChunk.style.cssText = `
                width: 100%;
                min-height: 100px;
                page-break-inside: avoid;
                break-inside: avoid;
                overflow: visible;
                position: relative;
            `
    }

    // Clone the child and add it to the current chunk
    const clonedChild = child.cloneNode(true) as HTMLElement

    // Ensure the cloned child maintains its styling
    clonedChild.style.cssText = child.style.cssText

    currentChunk.appendChild(clonedChild)
    currentChunkHeight += childHeight

    // If this is the last child, add the current chunk
    if (index === children.length - 1 && currentChunk) {
      chunks.push(currentChunk)
    }
  })

  // If no chunks were created (very small content), create one with all content
  if (chunks.length === 0) {
    const singleChunk = document.createElement('div')
    singleChunk.className = 'pdf-chunk'
    singleChunk.innerHTML = container.innerHTML
    chunks.push(singleChunk)
  }

  console.log(`Content broken into ${chunks.length} chunks`)
  return chunks
}

/**
 * Generates PDF from a single chunk
 */
const generateChunkPDF = async (
  chunk: HTMLElement,
  chunkIndex: number,
): Promise<Blob> => {
  const opt = {
    margin: [15, 15, 15, 15],
    filename: `chunk-${chunkIndex}.pdf`,
    image: {
      type: 'jpeg',
      quality: 0.98,
    },
    html2canvas: {
      scale: 2,
      useCORS: true,
      logging: false,
      allowTaint: true,
      imageTimeout: 15000,
      letterRendering: true,
      removeContainer: true,
      backgroundColor: '#ffffff',
      foreignObjectRendering: false,
    },
    jsPDF: {
      unit: 'pt',
      format: 'a4',
      orientation: 'portrait',
      compress: false,
      putOnlyUsedFonts: true,
      autoPaging: 'text',
    },
    pagebreak: {
      mode: ['css'],
      before: '.page-break-before',
      after: '.page-break-after',
      avoid: '.page-break-avoid',
    },
  }

  return await html2pdf().set(opt).from(chunk).output('blob')
}

/**
 * Combines multiple PDF blobs into a single PDF
 */
const combinePDFs = async (pdfBlobs: Blob[]): Promise<Blob> => {
  try {
    const pdfDoc = await PDFDocument.create()

    for (const pdfBlob of pdfBlobs) {
      const pdfBytes = await pdfBlob.arrayBuffer()
      const sourcePdf = await PDFDocument.load(pdfBytes)

      // Copy all pages from the source PDF
      const pageIndices = sourcePdf.getPageIndices()
      const copiedPages = await pdfDoc.copyPages(sourcePdf, pageIndices)

      // Add each copied page to the combined PDF
      copiedPages.forEach((page: any) => {
        pdfDoc.addPage(page)
      })
    }

    const combinedPdfBytes = await pdfDoc.save()
    return new Blob([combinedPdfBytes], { type: 'application/pdf' })
  } catch (error) {
    console.error('Error combining PDFs:', error)
    throw new Error('Failed to combine PDF chunks')
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
                // Force high-quality rendering after load
                img.style.imageRendering = 'high-quality'
                img.style.imageRendering = '-webkit-optimize-contrast'
                img.style.imageRendering = 'crisp-edges'
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
            new Promise(resolve => setTimeout(resolve, 5000)), // Balanced timeout
        ])
        console.log('Image loading complete')

        // Brief delay to ensure images are fully rendered
        await new Promise(resolve => setTimeout(resolve, 500))
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
    // Enhanced preprocessing for better image quality
    const images = container.querySelectorAll('img')
    images.forEach(img => {
        // High-quality image rendering settings
        img.style.imageRendering = 'high-quality'
        img.style.imageRendering = '-webkit-optimize-contrast'
        img.style.imageRendering = 'crisp-edges'
        img.style.objectFit = 'contain'
        img.style.objectPosition = 'center'

        // Remove size constraints that might limit quality
        img.style.maxWidth = 'none'
        img.style.maxHeight = 'none'
        img.style.minWidth = 'none'
        img.style.minHeight = 'none'

        // Smart image sizing that preserves aspect ratio and fits within bounds
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            // Convert natural dimensions to points (1px ≈ 0.75pt for typical screen density)
            const scaleFactor = 0.75
            let targetWidth = img.naturalWidth * scaleFactor
            let targetHeight = img.naturalHeight * scaleFactor

            // A4 page dimensions in points (595 x 842)
            const maxPageWidth = 500 // Leave some margin
            const maxPageHeight = 700 // Leave some margin

            // Check if image would overflow the page
            if (targetWidth > maxPageWidth || targetHeight > maxPageHeight) {
                // Scale down proportionally to fit within page bounds
                const widthRatio = maxPageWidth / targetWidth
                const heightRatio = maxPageHeight / targetHeight
                const scaleRatio = Math.min(widthRatio, heightRatio)

                targetWidth = targetWidth * scaleRatio
                targetHeight = targetHeight * scaleRatio
            }

            // Set dimensions to ensure full image display and visibility
            img.style.width = `${targetWidth}pt`
            img.style.height = `${targetHeight}pt`
            img.style.maxWidth = 'none'
            img.style.maxHeight = 'none'
            img.style.minWidth = 'auto'
            img.style.minHeight = 'auto'
            img.style.objectFit = 'contain'
            img.style.objectPosition = 'center'
            img.style.visibility = 'visible'
            img.style.display = 'block'
            img.style.opacity = '1'
        }

        // Ensure images don't break across pages and get proper spacing
        img.style.pageBreakInside = 'avoid'
        img.style.breakInside = 'avoid'
        img.style.pageBreakBefore = 'auto'
        img.style.breakBefore = 'auto'
        img.style.marginTop = '10px'
        img.style.marginBottom = '5px'

        // Force high-quality rendering
        img.crossOrigin = 'anonymous'
    })

    // Check photo containers and add page breaks if they're too large
    const largePhotoContainers = container.querySelectorAll(
        '.photo-report-container',
    )
    largePhotoContainers.forEach(container => {
        const containerElement = container as HTMLElement
        const rect = containerElement.getBoundingClientRect()

        // If photo container is taller than 500px, force page break before it
        if (rect.height > 500) {
            containerElement.style.pageBreakBefore = 'always'
            containerElement.style.breakBefore = 'page'
            console.log('Adding page break before large photo container')
        }
    })

    // Fix photo containers to prevent metadata cutoff and page breaks
    const photoContainers = container.querySelectorAll(
        '.photo-report-container',
    )
    photoContainers.forEach(container => {
        const containerElement = container as HTMLElement
        // Basic fixes for metadata visibility
        containerElement.style.overflow = 'visible'
        containerElement.style.maxHeight = 'none'
        containerElement.style.height = 'auto'

        // Moderate page break prevention for photo containers
        containerElement.style.pageBreakInside = 'avoid'
        containerElement.style.breakInside = 'avoid'
        containerElement.style.pageBreakBefore = 'auto'
        containerElement.style.breakBefore = 'auto'
        containerElement.style.pageBreakAfter = 'avoid'
        containerElement.style.breakAfter = 'avoid'

        // Ensure container allows content to be visible and never hidden
        containerElement.style.maxHeight = 'none' // Allow container to expand
        containerElement.style.overflow = 'visible' // Allow content to be visible
        containerElement.style.position = 'relative' // Ensure proper positioning
        containerElement.style.visibility = 'visible' // Ensure visibility
        containerElement.style.display = 'block' // Ensure display
        containerElement.style.opacity = '1' // Ensure full opacity
    })

    // Ensure metadata text is visible and doesn't get cut off
    const metadataTexts = container.querySelectorAll(
        '.photo-report-container small',
    )
    metadataTexts.forEach(text => {
        const textElement = text as HTMLElement
        textElement.style.overflow = 'visible'
        textElement.style.maxHeight = 'none'
        textElement.style.height = 'auto'
        textElement.style.display = 'block'
        textElement.style.pageBreakInside = 'avoid'
        textElement.style.breakInside = 'avoid'
        textElement.style.pageBreakAfter = 'avoid'
        textElement.style.breakAfter = 'avoid'
        textElement.style.marginBottom = '5px'
        textElement.style.visibility = 'visible'
        textElement.style.display = 'block'
        textElement.style.opacity = '1'
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
            elementStyle.pageBreakBefore = 'auto'
            elementStyle.breakBefore = 'auto'
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

        // Prevent orphaned text and ensure proper spacing and visibility
        if (element.tagName === 'P' || element.tagName === 'DIV') {
            elementStyle.orphans = '3'
            elementStyle.widows = '3'
            elementStyle.pageBreakInside = 'avoid'
            elementStyle.breakInside = 'avoid'
            elementStyle.pageBreakBefore = 'auto'
            elementStyle.breakBefore = 'auto'
            elementStyle.marginBottom = '10px'
            elementStyle.marginTop = '5px'
            elementStyle.visibility = 'visible'
            elementStyle.display = 'block'
            elementStyle.opacity = '1'
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

        // Ensure all elements are visible
        elementStyle.visibility = 'visible'
        elementStyle.display = elementStyle.display || 'block'
        elementStyle.opacity = '1'
    })
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

            // Check if content is too large and needs chunking
            const contentHeight = wrapper.scrollHeight
            const maxSingleChunkHeight = 3000 // Height threshold for chunking

            let finalPdfBlob: Blob

            if (contentHeight > maxSingleChunkHeight) {
              console.log(
                `Content height (${contentHeight}px) exceeds threshold, using chunking approach`,
              )

              // Break content into chunks
              const chunks = chunkContentForPDF(wrapper as HTMLElement)
              const pdfBlobs: Blob[] = []

              // Generate PDF for each chunk with error handling
              for (let i = 0; i < chunks.length; i++) {
                try {
                  console.log(
                    `Generating PDF for chunk ${i + 1}/${chunks.length}`,
                  )

                  // Preprocess images for this chunk
                  preprocessImagesForPDF(chunks[i])
                  await ensureAllImagesLoaded(chunks[i])

                  const chunkPdfBlob = await generateChunkPDF(
                    chunks[i],
                    i,
                  )
                  pdfBlobs.push(chunkPdfBlob)

                  console.log(
                    `Successfully generated PDF for chunk ${i + 1}`,
                  )
                } catch (chunkError) {
                  console.error(
                    `Error generating PDF for chunk ${i + 1}:`,
                    chunkError,
                  )
                  throw new Error(
                    `Failed to generate PDF for chunk ${i + 1}: ${chunkError}`,
                  )
                }
              }

              // Combine all PDF chunks into one
              console.log('Combining PDF chunks...')
              try {
                const combinedPdfBlob = await combinePDFs(pdfBlobs)
                finalPdfBlob = combinedPdfBlob
                console.log('Successfully combined all PDF chunks')
              } catch (combineError) {
                console.error('Error combining PDF chunks:', combineError)
                throw new Error(
                  `Failed to combine PDF chunks: ${combineError}`,
                )
              }
            } else {
              console.log(
                `Content height (${contentHeight}px) is within limits, using single PDF generation`,
              )
              // Use the original single PDF generation for smaller content
              const opt = {
                margin: [15, 15, 15, 15], // Balanced margins
                filename: 'report.pdf',
                image: {
                  type: 'jpeg',
                  quality: 0.98, // High quality but stable
                },
                html2canvas: {
                  scale: 2, // Balanced resolution for stability and quality
                  useCORS: true,
                  logging: false, // Disable logging for cleaner output
                  allowTaint: true, // Allow cross-origin images
                  imageTimeout: 15000, // Balanced timeout
                  letterRendering: true, // Better text rendering
                  removeContainer: true, // Remove container after processing
                  backgroundColor: '#ffffff', // Ensure white background
                  foreignObjectRendering: false, // Keep disabled for stability
                },
                jsPDF: {
                  unit: 'pt',
                  format: 'a4',
                  orientation: 'portrait',
                  compress: false, // Disable PDF compression for better image quality
                  putOnlyUsedFonts: true, // Optimize font usage
                  autoPaging: 'text', // Better text flow
                },
                pagebreak: {
                  mode: ['css'], // Simplified page break mode
                  before: '.page-break-before',
                  after: '.page-break-after',
                  avoid: '.page-break-avoid',
                },
              }

              const pdfBlob = await html2pdf()
                .set(opt)
                .from(wrapper)
                .output('blob')

              finalPdfBlob = pdfBlob
            }

            // Remove blank pages from the end of the PDF
            const cleanedPdfBlob = await removeBlankPagesFromPDF(finalPdfBlob)

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
