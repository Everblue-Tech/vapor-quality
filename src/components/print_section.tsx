import { useId, useState, FC, ReactNode, useEffect } from 'react'
import print from 'print-js'
import Button from 'react-bootstrap/Button'
import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import { PDFDocument, PDFName } from 'pdf-lib'
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
 * Interface for geotag link information
 */
interface GeotagLinkInfo {
    url: string
    text: string
    boundingRect: DOMRect
}

/**
 * Extracts all geotag links from the HTML container
 * Geotag links are identified by their href pattern (google.com/maps)
 */
const extractGeotagLinks = (container: HTMLElement): GeotagLinkInfo[] => {
    const geotagLinks: GeotagLinkInfo[] = []
    const allLinks = container.querySelectorAll('a[href*="google.com/maps"]')

    allLinks.forEach(link => {
        const href = link.getAttribute('href')
        const text = link.textContent?.trim() || ''
        const rect = link.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()

        // Calculate position relative to container
        const relativeRect = new DOMRect(
            rect.left - containerRect.left,
            rect.top - containerRect.top,
            rect.width,
            rect.height,
        )

        if (href && text) {
            geotagLinks.push({
                url: href,
                text,
                boundingRect: relativeRect,
            })
        }
    })

    return geotagLinks
}

/**
 * Adds clickable link annotations to geotags in the PDF
 * Since html2pdf renders to images, we approximate positions based on DOM coordinates
 */
const addGeotagLinksToPDF = async (
    pdfBlob: Blob,
    geotagLinks: GeotagLinkInfo[],
    containerHeight: number,
    containerWidth: number,
): Promise<Blob> => {
    try {
        const pdfBytes = await pdfBlob.arrayBuffer()
        const pdfDoc = await PDFDocument.load(pdfBytes)
        const pages = pdfDoc.getPages()

        if (pages.length === 0 || geotagLinks.length === 0) {
            return pdfBlob
        }

        // A4 dimensions in points (pdf-lib uses points)
        const a4Width = 595.28 // A4 width in points
        const a4Height = 841.89 // A4 height in points
        const margin = 15 // Margin in points (matching html2pdf margin)

        // Calculate scale factors
        // html2pdf uses 800px width, so scale factor accounts for that
        const scaleX = (a4Width - margin * 2) / containerWidth
        const scaleY = (a4Height - margin * 2) / containerHeight

        // Process each geotag link
        for (const geotagLink of geotagLinks) {
            const { url, boundingRect } = geotagLink

            // Calculate which page this link is on
            // Assuming content flows vertically and each page is approximately containerHeight / numPages
            const estimatedPageHeight = containerHeight / pages.length
            const pageIndex = Math.min(
                Math.floor(boundingRect.top / estimatedPageHeight),
                pages.length - 1,
            )

            const page = pages[pageIndex]
            const pageSize = page.getSize()

            // Convert DOM coordinates to PDF coordinates
            // PDF coordinates start from bottom-left, DOM from top-left
            const relativeTop = boundingRect.top % estimatedPageHeight
            const pdfX = margin + boundingRect.left * scaleX
            const pdfY =
                pageSize.height -
                margin -
                relativeTop * scaleY -
                boundingRect.height * scaleY

            // Ensure coordinates are within page bounds
            if (
                pdfX >= 0 &&
                pdfX <= pageSize.width &&
                pdfY >= 0 &&
                pdfY <= pageSize.height &&
                pdfX + boundingRect.width * scaleX <= pageSize.width
            ) {
                // Create link annotation using pdf-lib's annotation API
                const linkAnnotation = pdfDoc.context.register(
                    pdfDoc.context.obj({
                        Type: PDFName.of('Annot'),
                        Subtype: PDFName.of('Link'),
                        Rect: [
                            pdfX,
                            pdfY,
                            pdfX + boundingRect.width * scaleX,
                            pdfY + boundingRect.height * scaleY,
                        ],
                        Border: [0, 0, 0],
                        A: pdfDoc.context.obj({
                            Type: PDFName.of('Action'),
                            S: PDFName.of('URI'),
                            URI: url,
                        }),
                    }),
                )

                // Get or create the Annots array for this page
                const pageDict = page.node
                const existingAnnots = pageDict.get(PDFName.of('Annots'))

                // Build array of annotations (existing + new)
                const annotsToAdd: any[] = []
                if (existingAnnots) {
                    // If existingAnnots is already an array, spread it
                    // Otherwise, add it as a single item
                    try {
                        const existingArray = existingAnnots as any
                        if (Array.isArray(existingArray)) {
                            annotsToAdd.push(...existingArray)
                        } else {
                            annotsToAdd.push(existingAnnots)
                        }
                    } catch {
                        annotsToAdd.push(existingAnnots)
                    }
                }
                annotsToAdd.push(linkAnnotation)

                // Create and set the annotations array
                const annotsArray = pdfDoc.context.register(
                    pdfDoc.context.obj(annotsToAdd),
                )
                pageDict.set(PDFName.of('Annots'), annotsArray)
            }
        }

        // Save the modified PDF
        const modifiedPdfBytes = await pdfDoc.save()
        const buffer = new ArrayBuffer(modifiedPdfBytes.byteLength)
        const view = new Uint8Array(buffer)
        view.set(modifiedPdfBytes)
        return new Blob([buffer], {
            type: 'application/pdf',
        })
    } catch (error) {
        console.warn('Could not add geotag links to PDF:', error)
        return pdfBlob
    }
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
            const buffer = new ArrayBuffer(modifiedPdfBytes.byteLength)
            const view = new Uint8Array(buffer)
            view.set(modifiedPdfBytes)
            return new Blob([buffer], {
                type: 'application/pdf',
            })
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
 * Checks if an element contains images that should not be split
 */
const containsImages = (element: HTMLElement): boolean => {
    const images = element.querySelectorAll('img')
    return images.length > 0
}

/**
 * Checks if an element is an image container that should stay together
 */
const isImageContainer = (element: HTMLElement): boolean => {
    // Check for common image container classes
    const imageContainerClasses = [
        'photo-report-container',
        'image-container',
        'photo-container',
        'image-wrapper',
    ]

    return (
        imageContainerClasses.some(className =>
            element.classList.contains(className),
        ) || containsImages(element)
    )
}

/**
 * Breaks up large content into manageable chunks for PDF generation
 * Enhanced to prevent images from being split across pages
 */
const chunkContentForPDF = (container: HTMLElement): HTMLElement[] => {
    const chunks: HTMLElement[] = []
    const maxChunkHeight = 1200 // Canvas height limit
    const maxChunkWidth = 800 // Maximum width per chunk
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
        // Get the actual height and width of the child element
        const childHeight = Math.max(
            child.offsetHeight || 0,
            child.scrollHeight || 0,
            child.clientHeight || 0,
        )
        const childWidth = Math.max(
            child.offsetWidth || 0,
            child.scrollWidth || 0,
            child.clientWidth || 0,
        )

        // Check if this child contains images or is an image container
        const hasImages = isImageContainer(child)

        // CRITICAL: Images MUST always be in their own chunk to prevent splitting
        // For image containers, always start a new chunk to ensure they're not split
        // Also, if an image container is too large, it needs its own chunk
        const imageTooLarge = hasImages && childHeight > maxChunkHeight * 0.9

        // For image containers, we need to be more conservative about chunking
        const effectiveMaxHeight = hasImages
            ? maxChunkHeight * 0.7 // More conservative for images
            : maxChunkHeight

        // CRITICAL: Always start a new chunk for images - never put images with other content
        // Always start a new chunk for images if:
        // 1. This is an image (ALWAYS start new chunk)
        // 2. Current chunk has content (to avoid splitting images)
        // 3. Image is too large to fit in current chunk
        // 4. Image would exceed max height
        const shouldStartNewChunk =
            hasImages || // CRITICAL: ALWAYS new chunk for images
            imageTooLarge || // Image too large, needs its own chunk
            ((currentChunkHeight + childHeight > effectiveMaxHeight ||
                childWidth > maxChunkWidth) &&
                currentChunk) // Normal chunking logic

        if (shouldStartNewChunk && currentChunk) {
            chunks.push(currentChunk)
            currentChunk = null
            currentChunkHeight = 0
        }

        // Create a new chunk if we don't have one
        if (!currentChunk) {
            currentChunk = document.createElement('div')
            currentChunk.className = 'pdf-chunk'

            // Mark chunk if it contains images for special handling
            if (hasImages) {
                currentChunk.setAttribute('data-has-images', 'true')
            }

            // Enhanced styling for image containers
            const chunkStyles = hasImages
                ? `
                width: 100%;
                max-width: ${maxChunkWidth}px;
                min-height: 100px;
                page-break-inside: avoid !important;
                break-inside: avoid !important;
                page-break-before: auto;
                break-before: auto;
                overflow: visible;
                position: relative;
            `
                : `
                width: 100%;
                max-width: ${maxChunkWidth}px;
                min-height: 100px;
                page-break-inside: avoid;
                break-inside: avoid;
                overflow: visible;
                position: relative;
            `

            currentChunk.style.cssText = chunkStyles
        }

        // Clone the child and add it to the current chunk
        const clonedChild = child.cloneNode(true) as HTMLElement

        // Ensure the cloned child maintains its styling
        clonedChild.style.cssText = child.style.cssText

        // Add special styling for image containers to prevent page breaks
        if (hasImages) {
            clonedChild.style.pageBreakInside = 'avoid'
            clonedChild.style.breakInside = 'avoid'
            clonedChild.style.pageBreakBefore = 'auto'
            clonedChild.style.breakBefore = 'auto'
            clonedChild.style.pageBreakAfter = 'auto'
            clonedChild.style.breakAfter = 'auto'
            clonedChild.style.display = 'block'
            clonedChild.style.float = 'none'
            clonedChild.style.clear = 'both'
        }

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
 * Generates PDF from HTML element using html2canvas + jsPDF directly
 */
const generatePDFFromHTML = async (
    element: HTMLElement,
    options: {
        margin?: number
        scale?: number
        quality?: number
    } = {},
): Promise<Blob> => {
    const { margin = 15, scale = 1.5, quality = 0.98 } = options

    // Step 1: Capture HTML as canvas
    const canvas = await html2canvas(element, {
        scale: scale,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        logging: false,
        imageTimeout: 15000,
        width: element.scrollWidth,
        height: element.scrollHeight,
    })

    // Step 2: Create PDF
    const pdf = new jsPDF({
        unit: 'pt',
        format: 'a4',
        orientation: 'portrait',
        compress: false,
    })

    // Step 3: Calculate dimensions
    const pdfWidth = pdf.internal.pageSize.getWidth()
    const pdfHeight = pdf.internal.pageSize.getHeight()
    const marginPt = margin
    const contentWidth = pdfWidth - marginPt * 2
    const contentHeight = pdfHeight - marginPt * 2

    // Step 4: Convert canvas to image
    const imgData = canvas.toDataURL('image/jpeg', quality)
    const imgWidth = canvas.width
    const imgHeight = canvas.height

    // Step 5: Calculate scaling to fit PDF width
    const ratio = contentWidth / imgWidth
    const scaledHeight = imgHeight * ratio

    // Step 6: Split across pages if needed
    let heightLeft = scaledHeight
    let position = marginPt

    // Add first page
    pdf.addImage(
        imgData,
        'JPEG',
        marginPt,
        position,
        contentWidth,
        scaledHeight,
    )

    // Add additional pages if content is taller than one page
    while (heightLeft > contentHeight) {
        position -= contentHeight
        pdf.addPage()
        pdf.addImage(
            imgData,
            'JPEG',
            marginPt,
            position,
            contentWidth,
            scaledHeight,
        )
        heightLeft -= contentHeight
    }

    return pdf.output('blob')
}

/**
 * Generates PDF with special handling for images to prevent splitting
 * Each image gets its own page, scaled to 85% of page size
 */
const generatePDFWithImageHandling = async (
    container: HTMLElement,
): Promise<Blob> => {
    const pdf = new jsPDF({
        unit: 'pt',
        format: 'a4',
        orientation: 'portrait',
        compress: false,
    })

    const pdfWidth = pdf.internal.pageSize.getWidth()
    const pdfHeight = pdf.internal.pageSize.getHeight()
    const margin = 15
    const contentWidth = pdfWidth - margin * 2
    const contentHeight = pdfHeight - margin * 2

    // Separate images from other content
    const images = container.querySelectorAll('img')
    const imageContainers: HTMLElement[] = []
    const nonImageElements: HTMLElement[] = []

    // Process each direct child element
    Array.from(container.children).forEach(child => {
        const childEl = child as HTMLElement
        const hasImage = childEl.querySelector('img') !== null
        if (hasImage) {
            imageContainers.push(childEl)
        } else {
            nonImageElements.push(childEl)
        }
    })

    // Process non-image content first
    if (nonImageElements.length > 0) {
        const textContainer = document.createElement('div')
        textContainer.style.width = `${container.scrollWidth}px`
        nonImageElements.forEach(el => {
            textContainer.appendChild(el.cloneNode(true) as HTMLElement)
        })

        const canvas = await html2canvas(textContainer, {
            scale: 1.5,
            useCORS: true,
            allowTaint: true,
            backgroundColor: '#ffffff',
            logging: false,
            imageTimeout: 15000,
        })

        const imgData = canvas.toDataURL('image/jpeg', 0.98)
        const ratio = contentWidth / canvas.width
        const scaledHeight = canvas.height * ratio

        // Add to PDF with pagination
        let heightLeft = scaledHeight
        let position = margin

        pdf.addImage(
            imgData,
            'JPEG',
            margin,
            position,
            contentWidth,
            scaledHeight,
        )

        while (heightLeft > contentHeight) {
            position -= contentHeight
            pdf.addPage()
            pdf.addImage(
                imgData,
                'JPEG',
                margin,
                position,
                contentWidth,
                scaledHeight,
            )
            heightLeft -= contentHeight
        }
    }

    // Process each image separately - one per page
    for (const imageContainer of imageContainers) {
        pdf.addPage()

        const canvas = await html2canvas(imageContainer, {
            scale: 1.2,
            useCORS: true,
            allowTaint: true,
            backgroundColor: '#ffffff',
            logging: false,
            imageTimeout: 15000,
        })

        const imgData = canvas.toDataURL('image/jpeg', 0.98)

        // Scale image to fit page (85% as requested)
        const maxImageWidth = contentWidth * 0.85
        const maxImageHeight = contentHeight * 0.85
        const ratio = Math.min(
            maxImageWidth / canvas.width,
            maxImageHeight / canvas.height,
        )

        const scaledWidth = canvas.width * ratio
        const scaledHeight = canvas.height * ratio

        // Center image on page
        const x = margin + (contentWidth - scaledWidth) / 2
        const y = margin + (contentHeight - scaledHeight) / 2

        pdf.addImage(imgData, 'JPEG', x, y, scaledWidth, scaledHeight)
    }

    return pdf.output('blob')
}

/**
 * Generates PDF from a single chunk
 */
const generateChunkPDF = async (
    chunk: HTMLElement,
    chunkIndex: number,
): Promise<Blob> => {
    // Check if this chunk contains images
    const hasImages = chunk.getAttribute('data-has-images') === 'true'

    // Use new direct html2canvas + jsPDF approach
    return await generatePDFFromHTML(chunk, {
        margin: 15,
        scale: hasImages ? 1.2 : 1.5,
        quality: 0.98,
    })
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
        const buffer = new ArrayBuffer(combinedPdfBytes.byteLength)
        const view = new Uint8Array(buffer)
        view.set(combinedPdfBytes)
        return new Blob([buffer], {
            type: 'application/pdf',
        })
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
        const imgElement = img as HTMLImageElement

        // Check if image has valid dimensions
        const hasValidDimensions =
            imgElement.naturalWidth > 0 && imgElement.naturalHeight > 0

        if (imgElement.complete && hasValidDimensions) {
            console.log(
                `Image already loaded with dimensions ${imgElement.naturalWidth}x${imgElement.naturalHeight}:`,
                imgElement.src.substring(0, 100),
            )
            return
        }

        const promise = new Promise<void>(resolve => {
            const timeout = setTimeout(() => {
                console.warn(
                    `Image load timeout (${imgElement.naturalWidth}x${imgElement.naturalHeight}):`,
                    imgElement.src.substring(0, 100),
                )
                resolve() // Continue even if timeout
            }, 10000) // Increased timeout for large images

            imgElement.onload = () => {
                clearTimeout(timeout)
                if (
                    imgElement.naturalWidth > 0 &&
                    imgElement.naturalHeight > 0
                ) {
                    console.log(
                        `Image loaded successfully with dimensions ${imgElement.naturalWidth}x${imgElement.naturalHeight}:`,
                        imgElement.src.substring(0, 100),
                    )
                    // Force high-quality rendering after load
                    imgElement.style.imageRendering = 'high-quality'
                    imgElement.style.imageRendering =
                        '-webkit-optimize-contrast'
                    imgElement.style.imageRendering = 'crisp-edges'
                } else {
                    console.warn(
                        'Image loaded but has invalid dimensions:',
                        imgElement.src.substring(0, 100),
                    )
                }
                resolve()
            }
            imgElement.onerror = () => {
                clearTimeout(timeout)
                console.error(
                    'Image failed to load:',
                    imgElement.src.substring(0, 100),
                )
                resolve() // Continue even if image fails to load
            }

            // For blob URLs, ensure they're properly loaded
            if (imgElement.src.startsWith('blob:')) {
                // Blob URLs should load immediately, but verify
                if (!imgElement.complete) {
                    // Force reload
                    const currentSrc = imgElement.src
                    imgElement.src = ''
                    imgElement.src = currentSrc
                }
            }
        })
        imagePromises.push(promise)
    })

    if (imagePromises.length > 0) {
        console.log(`Waiting for ${imagePromises.length} images to load...`)
        // Wait for all images to load with a timeout
        await Promise.all(imagePromises)
        console.log('Image loading complete')

        // Additional delay to ensure images are fully rendered and dimensions are set
        await new Promise(resolve => setTimeout(resolve, 1000))

        // Verify all images have dimensions
        let imagesWithoutDimensions = 0
        images.forEach(img => {
            const imgElement = img as HTMLImageElement
            if (
                imgElement.naturalWidth === 0 ||
                imgElement.naturalHeight === 0
            ) {
                imagesWithoutDimensions++
                console.error(
                    `Image still has no dimensions after load: ${imgElement.naturalWidth}x${imgElement.naturalHeight}`,
                    imgElement.src.substring(0, 100),
                )
            }
        })
        if (imagesWithoutDimensions > 0) {
            console.warn(
                `${imagesWithoutDimensions} images still missing dimensions`,
            )
        }
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
const preprocessImagesForPDF = async (container: HTMLElement) => {
    // Enhanced preprocessing for better image quality
    const images = container.querySelectorAll('img')
    const imagePromises: Promise<void>[] = []

    images.forEach(img => {
        const processImage = async () => {
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
            // Wait for image to load if dimensions aren't available yet
            if (img.naturalWidth === 0 || img.naturalHeight === 0) {
                console.warn(
                    `Image has no dimensions yet (${img.naturalWidth}x${img.naturalHeight}), waiting for load:`,
                    img.src.substring(0, 100),
                )
                // Force image to load by setting src again or waiting
                if (img.complete === false) {
                    await new Promise<void>(resolve => {
                        const timeout = setTimeout(() => {
                            console.warn(
                                'Image load timeout:',
                                img.src.substring(0, 100),
                            )
                            resolve()
                        }, 3000)
                        img.onload = () => {
                            clearTimeout(timeout)
                            console.log(
                                'Image loaded with dimensions:',
                                img.src.substring(0, 100),
                            )
                            resolve()
                        }
                        img.onerror = () => {
                            clearTimeout(timeout)
                            console.error(
                                'Image failed to load:',
                                img.src.substring(0, 100),
                            )
                            resolve()
                        }
                        // Trigger reload if needed
                        if (img.src) {
                            const currentSrc = img.src
                            img.src = ''
                            img.src = currentSrc
                        }
                    })
                }
            }

            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                // A4 page dimensions in points (595 x 842)
                // Leave margins: 15pt on each side = 30pt total
                const maxPageWidth = 565 // 595 - 30 (margins)
                const maxPageHeight = 812 // 842 - 30 (margins)

                // CRITICAL: Calculate aspect ratio from natural dimensions
                const naturalAspectRatio = img.naturalWidth / img.naturalHeight

                console.log(
                    `Image: ${img.naturalWidth}x${img.naturalHeight}px, Aspect ratio: ${naturalAspectRatio.toFixed(3)}`,
                )

                // For html2pdf.js, convert points to pixels
                // html2pdf uses 800px canvas width for 595pt page width
                const html2canvasWidth = 800 // html2pdf canvas width
                const pageWidthPt = 595 // Full A4 width in points
                const scaleFactor = html2canvasWidth / pageWidthPt // ≈ 1.345

                // SIMPLE APPROACH: Scale large images to 85% of page size, preserve aspect ratio
                // This ensures they fit on one page and prevents splitting
                const targetPageWidth = maxPageWidth * 0.85 // 85% of available width
                const targetPageHeight = maxPageHeight * 0.85 // 85% of available height

                // Calculate dimensions to fit within 85% of page while preserving aspect ratio
                let targetWidth = targetPageWidth
                let targetHeight = targetPageWidth / naturalAspectRatio

                // If height exceeds 85% of page height, scale by height instead
                if (targetHeight > targetPageHeight) {
                    targetHeight = targetPageHeight
                    targetWidth = targetPageHeight * naturalAspectRatio
                }

                console.log(
                    `Image scaled to 85% of page: ${targetWidth.toFixed(0)}x${targetHeight.toFixed(0)}pt (preserving aspect ratio ${naturalAspectRatio.toFixed(3)})`,
                )

                // Convert to pixels
                const targetWidthPx = targetWidth * scaleFactor
                const targetHeightPx = targetHeight * scaleFactor

                // Set dimensions to 85% of page while preserving aspect ratio
                img.style.width = `${targetWidthPx}px`
                img.style.height = `${targetHeightPx}px`
                img.style.maxWidth = `${targetWidthPx}px`
                img.style.maxHeight = `${targetHeightPx}px`

                // CRITICAL: Force page breaks so image gets its own page with nothing else
                // Use multiple methods to ensure html2pdf respects this
                img.style.pageBreakBefore = 'always'
                img.style.breakBefore = 'page'
                img.style.pageBreakAfter = 'always'
                img.style.breakAfter = 'page'
                img.style.pageBreakInside = 'avoid'
                img.style.breakInside = 'avoid'
                // Add data attribute for html2pdf to recognize
                img.setAttribute('data-page-break', 'always')
                // Ensure image is treated as a block element that can't be split
                img.style.display = 'block'
                img.style.position = 'relative'

                // CRITICAL: Ensure no distortion - always preserve aspect ratio
                img.style.minWidth = '0'
                img.style.minHeight = '0'
                img.style.objectFit = 'contain' // Preserve aspect ratio, no cropping
                img.style.objectPosition = 'center'
                img.style.visibility = 'visible'
                img.style.display = 'block'
                img.style.opacity = '1'
                img.style.boxSizing = 'border-box'
                img.style.imageRendering = 'auto'
                // Lock aspect ratio
                img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`
            } else {
                console.error(
                    `Image still has no dimensions after waiting: ${img.naturalWidth}x${img.naturalHeight}`,
                    img.src.substring(0, 100),
                )
                // Set fallback dimensions to ensure image is visible
                // Use reduced height to account for headers/metadata
                img.style.width = 'auto'
                img.style.height = 'auto'
                img.style.maxWidth = '565pt'
                img.style.maxHeight = '762pt' // Reduced to prevent cutoff
            }

            // Page break settings are set above for large images
            // For images without dimensions, set defaults
            if (img.naturalWidth === 0 || img.naturalHeight === 0) {
                img.style.pageBreakInside = 'avoid'
                img.style.breakInside = 'avoid'
                img.style.pageBreakBefore = 'always'
                img.style.breakBefore = 'page'
                img.style.pageBreakAfter = 'always'
                img.style.breakAfter = 'page'
            }
            img.style.marginTop = '0'
            img.style.marginBottom = '0'

            // Additional CSS properties to prevent image splitting
            img.style.display = 'block'
            img.style.float = 'none'
            img.style.clear = 'both'
            img.style.orphans = '3'
            img.style.widows = '3'

            // Force high-quality rendering
            img.crossOrigin = 'anonymous'
        }
        imagePromises.push(processImage())
    })

    // Wait for all images to be processed
    await Promise.all(imagePromises)

    // CRITICAL: Apply page break styles directly to images and their containers
    // DO NOT wrap images - this breaks html2canvas rendering
    // Instead, apply styles directly to existing containers
    const allImages = container.querySelectorAll('img')
    allImages.forEach(img => {
        // CRITICAL: Ensure image is visible and has proper dimensions
        img.style.pageBreakInside = 'avoid'
        img.style.breakInside = 'avoid'
        img.style.pageBreakBefore = 'always'
        img.style.breakBefore = 'page'
        img.style.display = 'block'
        img.style.visibility = 'visible'
        img.style.opacity = '1'
        img.style.maxHeight = '650pt' // Limit to one page
        img.style.objectFit = 'contain'

        // Ensure image has width/height if they were set earlier
        if (!img.style.width && img.getAttribute('width')) {
            img.style.width = img.getAttribute('width') + 'px'
        }
        if (!img.style.height && img.getAttribute('height')) {
            img.style.height = img.getAttribute('height') + 'px'
        }

        // Apply page break styles to parent containers
        let parent = img.parentElement
        while (parent && parent !== container) {
            // Skip if already processed
            if (parent.classList.contains('image-isolated-page')) {
                break
            }

            // Apply to photo-report-container and other image containers
            if (
                parent.classList.contains('photo-report-container') ||
                parent.tagName === 'DIV'
            ) {
                parent.style.pageBreakInside = 'avoid'
                parent.style.breakInside = 'avoid'
                parent.style.pageBreakBefore = 'always'
                parent.style.breakBefore = 'page'
                parent.style.maxHeight = '650pt'
                parent.style.overflow = 'visible'
                parent.style.visibility = 'visible'
                parent.style.opacity = '1'
            }
            parent = parent.parentElement
        }
    })

    // Force a reflow to ensure styles are applied before html2pdf captures the content
    // This is critical for html2pdf.js to see the resized images
    container.offsetHeight // Force reflow
    await new Promise(resolve => setTimeout(resolve, 200)) // Longer delay for html2pdf

    // Check photo containers and ensure they fit on a page
    const largePhotoContainers = container.querySelectorAll(
        '.photo-report-container',
    )
    largePhotoContainers.forEach(container => {
        const containerElement = container as HTMLElement
        const rect = containerElement.getBoundingClientRect()

        // A4 page height in pixels (approximately 1123px at 96dpi)
        // Leave room for margins and metadata
        const maxContainerHeight = 800 // pixels

        // If photo container is taller than max height, scale down the image inside
        if (rect.height > maxContainerHeight) {
            const images = containerElement.querySelectorAll('img')
            images.forEach(img => {
                const imgElement = img as HTMLImageElement
                if (
                    imgElement.naturalWidth > 0 &&
                    imgElement.naturalHeight > 0
                ) {
                    // Calculate scale to fit container within max height
                    const containerHeight = rect.height
                    const scaleRatio = maxContainerHeight / containerHeight

                    // Calculate max dimensions in pixels (convert from points if needed)
                    // Assuming 96dpi: 1pt ≈ 1.33px
                    const maxHeightPx = maxContainerHeight
                    const aspectRatio =
                        imgElement.naturalWidth / imgElement.naturalHeight
                    const maxWidthPx = maxHeightPx * aspectRatio

                    // Use maxWidth/maxHeight instead of explicit dimensions
                    imgElement.style.width = 'auto'
                    imgElement.style.height = 'auto'
                    imgElement.style.maxWidth = `${maxWidthPx}px`
                    imgElement.style.maxHeight = `${maxHeightPx}px`
                    imgElement.style.objectFit = 'contain'

                    console.log(
                        `Scaling down photo container image to max ${maxWidthPx.toFixed(0)}x${maxHeightPx.toFixed(0)}px (aspect ratio preserved)`,
                    )
                }
            })
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

        // Wrap images in a container that prevents page breaks
        const images = containerElement.querySelectorAll('img')
        images.forEach(img => {
            // Create a wrapper div if it doesn't exist
            if (
                !img.parentElement?.classList.contains('image-no-break-wrapper')
            ) {
                const wrapper = document.createElement('div')
                wrapper.className = 'image-no-break-wrapper'
                wrapper.style.pageBreakInside = 'avoid'
                wrapper.style.breakInside = 'avoid'
                wrapper.style.display = 'block'
                wrapper.style.width = '100%'
                wrapper.style.maxWidth = '100%'
                img.parentNode?.insertBefore(wrapper, img)
                wrapper.appendChild(img)
            }
        })

        // Aggressive page break prevention for photo containers
        // CRITICAL: page-break-inside: avoid prevents the container from being split
        // page-break-before: auto allows it to start on a new page if needed (to avoid header conflicts)
        containerElement.style.pageBreakInside = 'avoid'
        containerElement.style.breakInside = 'avoid'
        containerElement.style.pageBreakBefore = 'auto' // Can start on new page if header pushes it
        containerElement.style.breakBefore = 'auto'
        containerElement.style.pageBreakAfter = 'auto'
        containerElement.style.breakAfter = 'auto'
        containerElement.style.display = 'block'
        containerElement.style.float = 'none'
        containerElement.style.clear = 'both'
        containerElement.style.orphans = '3'
        containerElement.style.widows = '3'

        // Ensure container allows content to be visible and never hidden
        containerElement.style.maxHeight = 'none' // Allow container to expand
        containerElement.style.overflow = 'visible' // Allow content to be visible
        containerElement.style.position = 'relative' // Ensure proper positioning
        containerElement.style.visibility = 'visible' // Ensure visibility
        containerElement.style.display = 'block' // Ensure display
        containerElement.style.opacity = '1' // Ensure full opacity

        // Add a class for html2pdf pagebreak configuration
        containerElement.classList.add('page-break-avoid')
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
            // Prevent word breaks within text
            elementStyle.wordBreak = 'keep-all'
            elementStyle.overflowWrap = 'normal'
        }

        // Prevent word breaks in all text elements
        if (
            element.tagName === 'SPAN' ||
            element.tagName === 'STRONG' ||
            element.tagName === 'EM' ||
            element.tagName === 'B' ||
            element.tagName === 'I' ||
            element.tagName === 'SMALL' ||
            element.tagName === 'LI'
        ) {
            elementStyle.wordBreak = 'keep-all'
            elementStyle.overflowWrap = 'normal'
            elementStyle.pageBreakInside = 'avoid'
            elementStyle.breakInside = 'avoid'
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

            // ensure all images are fully loaded BEFORE preprocessing
            // This is critical - preprocessing needs naturalWidth/naturalHeight
            await ensureAllImagesLoaded(wrapper as HTMLElement)

            // preprocess images for better PDF quality (after they're loaded)
            await preprocessImagesForPDF(wrapper as HTMLElement)

            // Extract geotag links before PDF generation
            const geotagLinks = extractGeotagLinks(wrapper as HTMLElement)
            console.log(
                `Found ${geotagLinks.length} geotag links to add to PDF`,
            )

            // Check if content is too large and needs chunking
            const contentHeight = wrapper.scrollHeight
            const contentWidth = wrapper.scrollWidth || 800 // Default to 800 if not available
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

                        // Ensure images are loaded BEFORE preprocessing
                        await ensureAllImagesLoaded(chunks[i])
                        // Preprocess images for this chunk (after they're loaded)
                        await preprocessImagesForPDF(chunks[i])

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

                        // Check if it's a canvas size error
                        if (
                            chunkError instanceof Error &&
                            (chunkError.message.includes(
                                'Canvas exceeds max size',
                            ) ||
                                chunkError.message.includes(
                                    'CanvasRenderingContext2D.scale',
                                ))
                        ) {
                            console.log(
                                `Canvas size error for chunk ${i + 1}, trying with smaller scale...`,
                            )

                            // Try with even smaller scale and dimensions
                            try {
                                const smallerOpt = {
                                    margin: [15, 15, 15, 15],
                                    filename: `chunk-${i}-small.pdf`,
                                    image: {
                                        type: 'jpeg',
                                        quality: 0.8, // Lower quality for smaller size
                                    },
                                    html2canvas: {
                                        scale: 1, // Minimal scale
                                        useCORS: true,
                                        logging: false,
                                        allowTaint: true,
                                        imageTimeout: 10000,
                                        letterRendering: true,
                                        removeContainer: true,
                                        backgroundColor: '#ffffff',
                                        foreignObjectRendering: false,
                                        width: 600, // Smaller width
                                        height: 800, // Smaller height
                                    },
                                    jsPDF: {
                                        unit: 'pt',
                                        format: 'a4',
                                        orientation: 'portrait',
                                        compress: true, // Enable compression
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

                                // Use new direct approach for fallback
                                const smallChunkPdfBlob =
                                    await generatePDFFromHTML(chunks[i], {
                                        margin: 15,
                                        scale: 1.0,
                                        quality: 0.8,
                                    })

                                pdfBlobs.push(smallChunkPdfBlob)
                                console.log(
                                    `Successfully generated PDF for chunk ${i + 1} with smaller scale`,
                                )
                            } catch (smallChunkError) {
                                console.error(
                                    `Failed to generate PDF for chunk ${i + 1} even with smaller scale:`,
                                    smallChunkError,
                                )
                                throw new Error(
                                    `Failed to generate PDF for chunk ${i + 1} due to canvas size limits: ${chunkError.message}`,
                                )
                            }
                        } else {
                            throw new Error(
                                `Failed to generate PDF for chunk ${i + 1}: ${chunkError}`,
                            )
                        }
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

                // Use new direct html2canvas + jsPDF approach with image handling
                finalPdfBlob = await generatePDFWithImageHandling(
                    wrapper as HTMLElement,
                )
            }

            // Remove blank pages from the end of the PDF
            const cleanedPdfBlob = await removeBlankPagesFromPDF(finalPdfBlob)

            // Add clickable geotag links to the PDF
            const pdfWithLinks = await addGeotagLinksToPDF(
                cleanedPdfBlob,
                geotagLinks,
                contentHeight,
                contentWidth,
            )

            // create document ID in vapor-core, upload to S3
            vaporCoreDocumentId = await uploadImageToS3AndCreateDocument({
                file: pdfWithLinks,
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
                    Report Submitted Successfully
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
