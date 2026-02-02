import { useId, useState, FC, ReactNode, useEffect } from 'react'
import print from 'print-js'
import Button from 'react-bootstrap/Button'
import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import { PDFDocument, PDFName, PDFString } from 'pdf-lib'
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
interface HyperlinkInfo {
    url: string
    text: string
    boundingRect: DOMRect
}

/**
 * Extracts all hyperlinks from the HTML container
 * This includes all <a> tags with href attributes
 */
const extractAllHyperlinks = (container: HTMLElement): HyperlinkInfo[] => {
    const hyperlinks: HyperlinkInfo[] = []
    // Extract ALL links with href attributes
    const allLinks = container.querySelectorAll('a[href]')

    allLinks.forEach(link => {
        const href = link.getAttribute('href')
        if (!href) {
            return // Skip links without href
        }

        // Get text content, fallback to href if text is empty
        const linkElement = link as HTMLElement
        const text =
            link.textContent?.trim() ||
            linkElement.innerText?.trim() ||
            href ||
            ''
        const rect = link.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()

        // Only process if link has valid dimensions (is visible)
        if (rect.width === 0 || rect.height === 0) {
            console.warn('Skipping hyperlink with zero dimensions:', href)
            return
        }

        // Calculate position relative to container
        const relativeRect = new DOMRect(
            rect.left - containerRect.left,
            rect.top - containerRect.top,
            rect.width,
            rect.height,
        )

        hyperlinks.push({
            url: href,
            text: text || 'Link', // Fallback text if empty
            boundingRect: relativeRect,
        })
        console.log(
            `Found hyperlink: "${text}" at (${relativeRect.left.toFixed(1)}, ${relativeRect.top.toFixed(1)})`,
        )
    })

    console.log(`Extracted ${hyperlinks.length} hyperlinks from container`)
    return hyperlinks
}

/**
 * Adds clickable link annotations to hyperlinks in the PDF
 * Updated for html2canvas + jsPDF approach with proper coordinate mapping
 */
const addHyperlinksToPDF = async (
    pdfBlob: Blob,
    hyperlinks: HyperlinkInfo[],
    containerHeight: number,
    containerWidth: number,
): Promise<Blob> => {
    try {
        const pdfBytes = await pdfBlob.arrayBuffer()
        const pdfDoc = await PDFDocument.load(pdfBytes)
        const pages = pdfDoc.getPages()

        if (pages.length === 0 || hyperlinks.length === 0) {
            console.log('No pages or hyperlinks to process')
            return pdfBlob
        }

        // A4 dimensions in points (pdf-lib and jsPDF both use points)
        const a4Width = 595.28 // A4 width in points
        const a4Height = 841.89 // A4 height in points
        const margin = 15 // Margin in points (matching jsPDF margin)
        const contentWidth = a4Width - margin * 2
        const contentHeight = a4Height - margin * 2

        // Calculate scale factors from DOM pixels to PDF points
        // html2canvas uses pixels, jsPDF uses points
        // At 96dpi: 1px = 0.75pt, but html2canvas scale affects this
        // We need to account for the actual rendered size
        const scaleX = contentWidth / containerWidth
        const scaleY = contentHeight / containerHeight

        console.log(
            `Adding ${hyperlinks.length} hyperlinks to PDF with scale factors: X=${scaleX.toFixed(3)}, Y=${scaleY.toFixed(3)}`,
        )

        // Process each hyperlink
        let linksAdded = 0
        let linksSkipped = 0

        for (const hyperlink of hyperlinks) {
            const { url, boundingRect, text } = hyperlink

            // Ensure URL is properly formatted and valid
            let finalUrl = url.trim()
            if (
                !finalUrl.startsWith('http://') &&
                !finalUrl.startsWith('https://')
            ) {
                finalUrl = `https://${finalUrl}`
            }

            // Validate URL format
            try {
                // Handle relative URLs by making them absolute if needed
                if (finalUrl.startsWith('/') || finalUrl.startsWith('#')) {
                    // Skip anchor links and relative paths that can't be resolved
                    console.warn(
                        `Skipping relative URL: ${finalUrl} (cannot be made absolute)`,
                    )
                    linksSkipped++
                    continue
                }
                new URL(finalUrl) // Validate URL format
            } catch (e) {
                // If URL is invalid, try to make it absolute
                try {
                    finalUrl = new URL(finalUrl, window.location.origin).href
                } catch (e2) {
                    console.warn(
                        `Invalid hyperlink URL format: ${finalUrl}, skipping`,
                    )
                    linksSkipped++
                    continue
                }
            }

            // Try to find the correct page by checking all pages
            // Since pages can have variable heights (images get their own pages),
            // we'll try each page and see if the coordinates fit
            let linkAdded = false

            for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
                const page = pages[pageIndex]
                const pageSize = page.getSize()

                // Calculate which page this link should be on based on content height
                // Account for the fact that images get their own pages, so content might be spread out
                // Each page can hold approximately contentHeight of content
                const estimatedPageHeight = contentHeight

                // Calculate which page the link should be on
                const linkTopPage = Math.floor(
                    boundingRect.top / estimatedPageHeight,
                )

                // Only check this page if the link's top position suggests it's on this page
                // Allow checking adjacent pages for better matching
                if (
                    linkTopPage !== pageIndex &&
                    linkTopPage !== pageIndex - 1 &&
                    linkTopPage !== pageIndex + 1 &&
                    linkTopPage < pages.length - 1
                ) {
                    continue
                }

                // Calculate position within the page
                // PDF coordinates: (0,0) is bottom-left, DOM: (0,0) is top-left
                const pdfX = margin + boundingRect.left * scaleX

                // Calculate relative position on the page
                // Account for which page we're on
                const relativeTop =
                    boundingRect.top - linkTopPage * estimatedPageHeight

                // Convert from top-left (DOM) to bottom-left (PDF) coordinate system
                const pdfY =
                    pageSize.height -
                    margin -
                    relativeTop * scaleY -
                    boundingRect.height * scaleY

                // Calculate link bounds
                const linkWidth = Math.max(1, boundingRect.width * scaleX) // Ensure minimum width
                const linkHeight = Math.max(1, boundingRect.height * scaleY) // Ensure minimum height

                // Check if coordinates are within page bounds (with some tolerance)
                const tolerance = 5 // Allow 5pt tolerance
                if (
                    pdfX >= margin - tolerance &&
                    pdfX + linkWidth <= pageSize.width - margin + tolerance &&
                    pdfY >= margin - tolerance &&
                    pdfY + linkHeight <= pageSize.height - margin + tolerance
                ) {
                    try {
                        // Clamp coordinates to page bounds
                        const clampedX = Math.max(
                            margin,
                            Math.min(pdfX, pageSize.width - margin - linkWidth),
                        )
                        const clampedY = Math.max(
                            margin,
                            Math.min(
                                pdfY,
                                pageSize.height - margin - linkHeight,
                            ),
                        )

                        // Create link annotation using pdf-lib's annotation API
                        // Use proper PDF annotation format for maximum compatibility and clickability
                        // Rect must be an array of 4 numbers: [x1, y1, x2, y2] in PDF coordinates
                        const linkAnnotationDict = pdfDoc.context.obj({
                            Type: PDFName.of('Annot'),
                            Subtype: PDFName.of('Link'),
                            Rect: [
                                clampedX,
                                clampedY,
                                clampedX + linkWidth,
                                clampedY + linkHeight,
                            ],
                            Border: [0, 0, 0], // No visible border: [horizontal, vertical, width]
                            A: pdfDoc.context.obj({
                                Type: PDFName.of('Action'),
                                S: PDFName.of('URI'),
                                URI: PDFString.of(finalUrl), // Properly encode URI as PDFString
                            }),
                            // Ensure link is visible and clickable
                            F: 4, // Print flag - make link visible when printing
                            H: PDFName.of('I'), // Highlight mode: Invert (shows link on hover/click)
                        })

                        const linkAnnotation =
                            pdfDoc.context.register(linkAnnotationDict)

                        // Get or create the Annots array for this page
                        const pageDict = page.node
                        let existingAnnots = pageDict.get(PDFName.of('Annots'))

                        // Build array of annotations (existing + new)
                        const annotsToAdd: any[] = []
                        if (existingAnnots) {
                            try {
                                // Try to get the actual array from the PDF reference
                                const existingAnnotsRef = existingAnnots as any
                                if (
                                    existingAnnotsRef &&
                                    existingAnnotsRef.array
                                ) {
                                    const existingArray =
                                        existingAnnotsRef.array()
                                    if (Array.isArray(existingArray)) {
                                        annotsToAdd.push(...existingArray)
                                    } else {
                                        annotsToAdd.push(existingAnnotsRef)
                                    }
                                } else {
                                    annotsToAdd.push(existingAnnotsRef)
                                }
                            } catch (e) {
                                // If we can't parse existing annotations, just add the new one
                                console.warn(
                                    `Could not parse existing annotations on page ${pageIndex + 1}, adding new link:`,
                                    e,
                                )
                            }
                        }
                        annotsToAdd.push(linkAnnotation)

                        // Create and set the annotations array using proper pdf-lib API
                        const annotsArray = pdfDoc.context.register(
                            pdfDoc.context.obj(annotsToAdd),
                        )
                        pageDict.set(PDFName.of('Annots'), annotsArray)

                        console.log(
                            `✓ Added hyperlink "${text}" to page ${pageIndex + 1} at (${clampedX.toFixed(1)}, ${clampedY.toFixed(1)}) with URL: ${finalUrl}`,
                        )
                        linksAdded++
                        linkAdded = true
                        break // Found the right page, move to next link
                    } catch (linkError) {
                        console.error(
                            `Error adding hyperlink "${text}" to page ${pageIndex + 1}:`,
                            linkError,
                        )
                        // Continue trying other pages
                    }
                }
            }

            if (!linkAdded) {
                console.warn(
                    `✗ Could not place hyperlink "${text}" on any page. Position: top=${boundingRect.top.toFixed(1)}, left=${boundingRect.left.toFixed(1)}, URL: ${finalUrl}`,
                )
                linksSkipped++
            }
        }

        console.log(
            `Hyperlinks summary: ${linksAdded} added, ${linksSkipped} skipped out of ${hyperlinks.length} total`,
        )

        // Save the modified PDF
        const modifiedPdfBytes = await pdfDoc.save()
        const buffer = new ArrayBuffer(modifiedPdfBytes.byteLength)
        const view = new Uint8Array(buffer)
        view.set(modifiedPdfBytes)
        return new Blob([buffer], {
            type: 'application/pdf',
        })
    } catch (error) {
        console.error('Could not add hyperlinks to PDF:', error)
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

    // Validate element is in DOM
    if (!element || !element.parentNode) {
        throw new Error('Element is not attached to DOM')
    }

    // Ensure element is visible
    const originalDisplay = element.style.display
    const originalVisibility = element.style.visibility
    element.style.display = 'block'
    element.style.visibility = 'visible'

    try {
        // Step 1: Capture HTML as canvas
        const canvas = await html2canvas(element, {
            scale: scale,
            useCORS: true,
            allowTaint: true,
            backgroundColor: '#ffffff',
            logging: false,
            imageTimeout: 15000,
            width: element.scrollWidth || element.offsetWidth || 800,
            height: element.scrollHeight || element.offsetHeight || 1200,
            removeContainer: false, // Keep element in DOM
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
        // Use PNG for maximum quality, fallback to JPEG if needed
        const imgData = canvas.toDataURL('image/png')
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
            'PNG', // Use PNG for maximum quality
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
                'PNG', // Use PNG for maximum quality
                marginPt,
                position,
                contentWidth,
                scaledHeight,
            )
            heightLeft -= contentHeight
        }

        return pdf.output('blob')
    } finally {
        // Restore original styles
        element.style.display = originalDisplay
        element.style.visibility = originalVisibility
    }
}

/**
 * Generates PDF with special handling for images to prevent splitting
 * Each image container gets its own page, scaled to 85% of page size
 * Processes content sequentially to maintain order
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
    // Add extra padding between sections to prevent overlap
    const sectionPadding = 20
    const contentWidth = pdfWidth - margin * 2
    const contentHeight = pdfHeight - margin * 2 - sectionPadding

    // Find all photo-report-container elements (these contain images)
    const photoContainers = Array.from(
        container.querySelectorAll('.photo-report-container'),
    ) as HTMLElement[]

    // Process content sequentially, maintaining order
    const children = Array.from(container.children) as HTMLElement[]
    let currentTextElements: HTMLElement[] = []

    for (const child of children) {
        // Check if this child contains a photo-report-container
        const hasPhotoContainer =
            child.querySelector('.photo-report-container') !== null

        if (hasPhotoContainer) {
            // First, render any accumulated text content BEFORE processing images
            // Add extra padding after text to ensure separation
            if (currentTextElements.length > 0) {
                await renderTextContentToPDF(
                    pdf,
                    currentTextElements,
                    contentWidth,
                    contentHeight,
                    margin,
                )
                currentTextElements = []
                // Add a blank page after text to ensure clear separation before images
                pdf.addPage()
            }

            // Extract text content from this child (like Card.Title, Card.Text)
            // but exclude photo-report-containers - render this BEFORE images
            const textElements: HTMLElement[] = []
            Array.from(child.children).forEach(grandchild => {
                const grandchildEl = grandchild as HTMLElement
                const isPhotoContainer =
                    grandchildEl.classList.contains('photo-report-container') ||
                    grandchildEl.querySelector('.photo-report-container') !==
                        null
                if (!isPhotoContainer) {
                    textElements.push(grandchildEl)
                }
            })

            // Render text content FIRST (if any) - this ensures text is on separate pages
            if (textElements.length > 0) {
                await renderTextContentToPDF(
                    pdf,
                    textElements,
                    contentWidth,
                    contentHeight,
                    margin,
                )
                // Add a blank page after text to ensure clear separation before images
                pdf.addPage()
            }

            // NOW render each photo container on its own SEPARATE page
            // Each image gets its own page with nothing else
            const photoContainersInChild = Array.from(
                child.querySelectorAll('.photo-report-container'),
            ) as HTMLElement[]

            for (const photoContainer of photoContainersInChild) {
                // Each image gets its own page - no text, no other content
                await renderImageContainerToPDF(
                    pdf,
                    photoContainer,
                    contentWidth,
                    contentHeight,
                    margin,
                )
                // Add a blank page after each image to ensure clear separation
                pdf.addPage()
            }
        } else {
            // Accumulate text content
            currentTextElements.push(child)
        }
    }

    // Render any remaining text content
    if (currentTextElements.length > 0) {
        await renderTextContentToPDF(
            pdf,
            currentTextElements,
            contentWidth,
            contentHeight,
            margin,
        )
    }

    return pdf.output('blob')
}

/**
 * Renders text content to PDF with pagination
 */
const renderTextContentToPDF = async (
    pdf: jsPDF,
    elements: HTMLElement[],
    contentWidth: number,
    contentHeight: number,
    margin: number,
): Promise<void> => {
    // Create temporary container for text elements
    const textContainer = document.createElement('div')
    textContainer.style.width = `${contentWidth}px`
    textContainer.style.display = 'block'
    textContainer.style.visibility = 'visible'
    textContainer.style.position = 'absolute'
    textContainer.style.left = '-9999px'
    textContainer.style.top = '0'
    document.body.appendChild(textContainer)

    // Clone elements to avoid modifying originals
    elements.forEach(el => {
        const clone = el.cloneNode(true) as HTMLElement
        // Hide any images and photo-report-containers in cloned text content
        clone.querySelectorAll('img').forEach(img => {
            ;(img as HTMLElement).style.display = 'none'
        })
        clone.querySelectorAll('.photo-report-container').forEach(container => {
            ;(container as HTMLElement).style.display = 'none'
        })
        textContainer.appendChild(clone)
    })

    try {
        const canvas = await html2canvas(textContainer, {
            scale: 2.0, // Increased from 1.5 to 2.0 for better quality
            useCORS: true,
            allowTaint: true,
            backgroundColor: '#ffffff',
            logging: false,
            imageTimeout: 15000,
            removeContainer: false,
        })

        const imgData = canvas.toDataURL('image/png') // Use PNG for better quality
        const ratio = contentWidth / canvas.width
        const scaledHeight = canvas.height * ratio

        // Add to PDF with pagination
        let heightLeft = scaledHeight
        let position = margin

        pdf.addImage(
            imgData,
            'PNG', // Use PNG for maximum quality
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
    } finally {
        if (textContainer.parentNode) {
            document.body.removeChild(textContainer)
        }
    }
}

/**
 * Renders a single image container to PDF on its own page
 * Uses direct image rendering to prevent splitting and ensure exact sizing
 */
const renderImageContainerToPDF = async (
    pdf: jsPDF,
    imageContainer: HTMLElement,
    contentWidth: number,
    contentHeight: number,
    margin: number,
): Promise<void> => {
    // Get PDF page dimensions for boundary checks
    const pdfWidth = pdf.internal.pageSize.getWidth()
    const pdfHeight = pdf.internal.pageSize.getHeight()

    // Find the actual image element within the container
    const img = imageContainer.querySelector('img') as HTMLImageElement
    if (!img) {
        console.warn('No image found in container, skipping')
        return
    }

    // Wait for image to be fully loaded
    if (!img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) {
        await new Promise<void>(resolve => {
            if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
                resolve()
            } else {
                img.onload = () => resolve()
                img.onerror = () => resolve()
                setTimeout(() => resolve(), 2000)
            }
        })
    }

    if (img.naturalWidth === 0 || img.naturalHeight === 0) {
        console.warn('Image has no dimensions after waiting, skipping')
        return
    }

    // Calculate target size (75% of page height for maximum quality) in PDF points
    // Using 75% to maximize image detail while maintaining safety margin
    const maxImageHeightPt = contentHeight * 0.75
    // Width should also be constrained to 75% to maintain proportions
    const maxImageWidthPt = contentWidth * 0.75

    // Use natural image dimensions to calculate scaling
    const imageAspectRatio = img.naturalWidth / img.naturalHeight
    let targetWidthPt = maxImageWidthPt
    let targetHeightPt = maxImageWidthPt / imageAspectRatio

    // If height exceeds max (65% of page height), scale by height instead
    if (targetHeightPt > maxImageHeightPt) {
        targetHeightPt = maxImageHeightPt
        targetWidthPt = maxImageHeightPt * imageAspectRatio
    }

    // Ensure dimensions don't exceed maximums (strict safety check)
    targetWidthPt = Math.min(targetWidthPt, maxImageWidthPt)
    targetHeightPt = Math.min(targetHeightPt, maxImageHeightPt)

    // Additional strict checks: ensure dimensions don't exceed available space
    // Account for margins on both sides
    const availableSpaceWidth = pdfWidth - margin * 2
    const availableSpaceHeight = pdfHeight - margin * 2
    targetWidthPt = Math.min(targetWidthPt, availableSpaceWidth)
    targetHeightPt = Math.min(targetHeightPt, availableSpaceHeight)

    // Create a new page for this image (BEFORE rendering)
    pdf.addPage()

    // Create a canvas directly from the image
    // This ensures we get the exact image without any container artifacts
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) {
        console.warn('Could not get canvas context')
        return
    }

    // Calculate available space FIRST to ensure we don't exceed it
    const availableWidth = pdfWidth - margin * 2
    const availableHeight = pdfHeight - margin * 2

    // Ensure target dimensions don't exceed available space
    const safeTargetWidthPt = Math.min(targetWidthPt, availableWidth)
    const safeTargetHeightPt = Math.min(targetHeightPt, availableHeight)

    // Set canvas size at HIGH RESOLUTION for best possible image quality
    // Use 3x resolution multiplier: 1pt = 3 * (96/72) px = 4px
    // This gives us maximum image quality when rendered to PDF
    const resolutionMultiplier = 3 // 3x resolution for maximum sharpness
    const targetWidthPx = Math.floor(
        safeTargetWidthPt * (96 / 72) * resolutionMultiplier,
    )
    const targetHeightPx = Math.floor(
        safeTargetHeightPt * (96 / 72) * resolutionMultiplier,
    )
    canvas.width = targetWidthPx
    canvas.height = targetHeightPx

    // Enable high-quality image rendering
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    // Fill with white background
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // Calculate how to draw the image to fit exactly within canvas bounds
    // Use the image's natural dimensions to maintain aspect ratio
    const imgAspectRatio = img.naturalWidth / img.naturalHeight
    const canvasAspectRatio = canvas.width / canvas.height

    let drawWidth = canvas.width
    let drawHeight = canvas.height
    let drawX = 0
    let drawY = 0

    // If image is wider than canvas aspect ratio, fit to width
    if (imgAspectRatio > canvasAspectRatio) {
        drawWidth = canvas.width
        drawHeight = canvas.width / imgAspectRatio
        drawY = (canvas.height - drawHeight) / 2 // Center vertically
    } else {
        // Image is taller, fit to height
        drawHeight = canvas.height
        drawWidth = canvas.height * imgAspectRatio
        drawX = (canvas.width - drawWidth) / 2 // Center horizontally
    }

    // Draw the image at high resolution using natural dimensions
    ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight)

    // Convert to image data at maximum quality
    // Use PNG for lossless quality (no compression artifacts)
    const imgData = canvas.toDataURL('image/png') // Lossless PNG quality

    // Final dimensions: scale down from high-res canvas to PDF points
    // Canvas was created with: targetWidthPx = safeTargetWidthPt * (96/72) * resolutionMultiplier
    // So: safeTargetWidthPt = targetWidthPx * (72/96) / resolutionMultiplier
    const canvasWidthPt = (canvas.width * 72) / (96 * resolutionMultiplier)
    const canvasHeightPt = (canvas.height * 72) / (96 * resolutionMultiplier)

    // Double-check: ensure final dimensions don't exceed available space
    const finalWidthPt = Math.floor(
        Math.min(canvasWidthPt, availableWidth, maxImageWidthPt, contentWidth),
    )
    const finalHeightPt = Math.floor(
        Math.min(
            canvasHeightPt,
            availableHeight,
            maxImageHeightPt,
            contentHeight,
        ),
    )

    // Double-check: ensure final dimensions are positive and within bounds
    if (finalWidthPt <= 0 || finalHeightPt <= 0) {
        console.warn('Image dimensions invalid, skipping')
        return
    }

    // Verify dimensions fit within available space (strict check)
    if (finalWidthPt > availableWidth || finalHeightPt > availableHeight) {
        console.warn(
            `Image too large, reducing. Requested: ${finalWidthPt}x${finalHeightPt}, Available: ${availableWidth}x${availableHeight}`,
        )
        // Force fit within available space
        const scale = Math.min(
            availableWidth / finalWidthPt,
            availableHeight / finalHeightPt,
        )
        const adjustedWidth = Math.floor(finalWidthPt * scale)
        const adjustedHeight = Math.floor(finalHeightPt * scale)

        // Recalculate canvas with adjusted dimensions at high resolution
        const adjustedWidthPx = Math.floor(
            adjustedWidth * (96 / 72) * resolutionMultiplier,
        )
        const adjustedHeightPx = Math.floor(
            adjustedHeight * (96 / 72) * resolutionMultiplier,
        )
        canvas.width = adjustedWidthPx
        canvas.height = adjustedHeightPx

        // Enable high-quality image rendering
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'

        // Redraw with adjusted size
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)

        const adjustedImgAspectRatio = img.naturalWidth / img.naturalHeight
        const adjustedCanvasAspectRatio = canvas.width / canvas.height

        let drawWidth = canvas.width
        let drawHeight = canvas.height
        let drawX = 0
        let drawY = 0

        if (adjustedImgAspectRatio > adjustedCanvasAspectRatio) {
            drawWidth = canvas.width
            drawHeight = canvas.width / adjustedImgAspectRatio
            drawY = (canvas.height - drawHeight) / 2
        } else {
            drawHeight = canvas.height
            drawWidth = canvas.height * adjustedImgAspectRatio
            drawX = (canvas.width - drawWidth) / 2
        }

        ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight)
        const adjustedImgData = canvas.toDataURL('image/png') // Lossless PNG quality

        // Add at top-left margin to ensure no overflow
        pdf.addImage(
            adjustedImgData,
            'PNG',
            margin,
            margin,
            adjustedWidth,
            adjustedHeight,
        )
        return
    }

    // Calculate centered position
    const x = margin + (contentWidth - finalWidthPt) / 2
    const y = margin + (contentHeight - finalHeightPt) / 2

    // Strict boundary checks - ensure image stays within page margins
    // Calculate maximum allowed positions
    const maxX = pdfWidth - margin - finalWidthPt
    const maxY = pdfHeight - margin - finalHeightPt

    // Clamp position to ensure no overflow (use Math.floor for safety)
    const finalX = Math.floor(Math.max(margin, Math.min(x, maxX)))
    const finalY = Math.floor(Math.max(margin, Math.min(y, maxY)))

    // Final validation: ensure image fits completely within page
    // Check all four corners with strict validation
    const rightEdge = finalX + finalWidthPt
    const bottomEdge = finalY + finalHeightPt
    const maxRight = pdfWidth - margin
    const maxBottom = pdfHeight - margin

    // Use finalWidthPt and finalHeightPt which preserve aspect ratio
    // These were calculated from the image's natural aspect ratio
    const finalPdfWidth = finalWidthPt
    const finalPdfHeight = finalHeightPt

    // Verify position is safe
    if (
        finalX < margin ||
        finalY < margin ||
        finalX + finalPdfWidth > maxRight ||
        finalY + finalPdfHeight > maxBottom
    ) {
        console.warn(
            `Image position unsafe. Using safe position. X: ${finalX}, Y: ${finalY}, W: ${finalPdfWidth}, H: ${finalPdfHeight}`,
        )
        // Force to top-left corner with safe dimensions (preserving aspect ratio)
        pdf.addImage(
            imgData,
            'PNG',
            margin,
            margin,
            finalPdfWidth,
            finalPdfHeight,
        )
    } else {
        // Add image to PDF - using dimensions that preserve aspect ratio
        pdf.addImage(
            imgData,
            'PNG',
            finalX,
            finalY,
            finalPdfWidth,
            finalPdfHeight,
        )
    }
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
    // Higher scale for images to maximize quality
    return await generatePDFFromHTML(chunk, {
        margin: 15,
        scale: hasImages ? 2.0 : 1.5, // Increased from 1.2 to 2.0 for better image quality
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

            // Extract all hyperlinks before PDF generation
            const hyperlinks = extractAllHyperlinks(wrapper as HTMLElement)
            console.log(`Found ${hyperlinks.length} hyperlinks to add to PDF`)

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

                        // Ensure chunk is in DOM and visible before rendering
                        if (!chunks[i].parentNode) {
                            // Temporarily append to body if not in DOM
                            document.body.appendChild(chunks[i])
                        }
                        const originalDisplay = chunks[i].style.display
                        chunks[i].style.display = 'block'
                        chunks[i].style.visibility = 'visible'

                        try {
                            const chunkPdfBlob = await generateChunkPDF(
                                chunks[i],
                                i,
                            )
                            pdfBlobs.push(chunkPdfBlob)
                            console.log(
                                `Successfully generated PDF for chunk ${i + 1}`,
                            )
                        } finally {
                            // Restore original display
                            chunks[i].style.display = originalDisplay
                            // Remove from body if we added it
                            if (chunks[i].parentNode === document.body) {
                                document.body.removeChild(chunks[i])
                            }
                        }
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

            // Add clickable hyperlinks to the PDF
            const pdfWithLinks = await addHyperlinksToPDF(
                cleanedPdfBlob,
                hyperlinks,
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
