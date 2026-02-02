# Migration Plan: html2pdf.js → html2canvas + jsPDF

## Current Situation

-   **Current Library**: html2pdf.js v0.10.3
-   **Issues**:
    -   Images splitting across pages (top 20% going to previous page)
    -   Images not showing up in PDFs
    -   Unreliable page break handling
    -   Limited control over rendering process

## Why Migrate to html2canvas + jsPDF Directly?

### Benefits:

1. **Full Control**: Direct control over canvas rendering and PDF page creation
2. **Better Image Handling**: Can capture each image separately and place on its own page
3. **Predictable Behavior**: No hidden page break logic - we control it explicitly
4. **Better Debugging**: Can inspect canvas before PDF generation
5. **More Reliable**: Fewer abstraction layers = fewer bugs

### Current Dependencies:

-   ✅ `jspdf` v3.0.1 - Already installed
-   ❌ `html2canvas` - Need to install (html2pdf.js includes it but we need direct access)

## Migration Steps

### Phase 1: Setup & Installation

1. **Install html2canvas directly**

    ```bash
    npm install html2canvas
    ```

2. **Update imports in `print_section.tsx`**

    ```typescript
    // Remove:
    import html2pdf from 'html2pdf.js'

    // Add:
    import html2canvas from 'html2canvas'
    import { jsPDF } from 'jspdf'
    ```

### Phase 2: Create New PDF Generation Functions

#### 2.1 Create `generatePDFFromHTML` function

Replace the html2pdf.js wrapper with direct html2canvas + jsPDF:

```typescript
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
        letterRendering: true,
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
```

#### 2.2 Create `generatePDFWithImageHandling` function

Handle images separately to prevent splitting:

```typescript
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
    const nonImageContent: HTMLElement[] = []

    // Process each element
    Array.from(container.children).forEach(child => {
        const hasImage = child.querySelector('img') !== null
        if (hasImage) {
            imageContainers.push(child as HTMLElement)
        } else {
            nonImageContent.push(child as HTMLElement)
        }
    })

    // Process non-image content first
    if (nonImageContent.length > 0) {
        const textContainer = document.createElement('div')
        nonImageContent.forEach(el => {
            textContainer.appendChild(el.cloneNode(true))
        })

        const canvas = await html2canvas(textContainer, {
            scale: 1.5,
            useCORS: true,
            backgroundColor: '#ffffff',
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
            backgroundColor: '#ffffff',
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
```

### Phase 3: Update Existing Functions

#### 3.1 Replace `generateChunkPDF`

```typescript
const generateChunkPDF = async (
    chunk: HTMLElement,
    chunkIndex: number,
): Promise<Blob> => {
    const hasImages = chunk.getAttribute('data-has-images') === 'true'

    return await generatePDFFromHTML(chunk, {
        margin: 15,
        scale: hasImages ? 1.2 : 1.5,
        quality: 0.98,
    })
}
```

#### 3.2 Update `handleSubmitReport`

Replace the html2pdf.js calls with new functions:

```typescript
// OLD:
const pdfBlob = await html2pdf().set(opt).from(wrapper).output('blob')

// NEW:
const pdfBlob = await generatePDFWithImageHandling(wrapper as HTMLElement)
```

### Phase 4: Handle Geotag Links

Since we're generating PDFs directly, we can still use pdf-lib to add links:

```typescript
// After generating PDF blob
const pdfWithLinks = await addGeotagLinksToPDF(
    pdfBlob,
    geotagLinks,
    contentHeight,
    contentWidth,
)
```

This function already uses pdf-lib, so it should work unchanged.

### Phase 5: Testing & Refinement

1. **Test with small content** (no images)
2. **Test with single image**
3. **Test with multiple images**
4. **Test with mixed content** (text + images)
5. **Verify geotag links still work**
6. **Check PDF file size** (may be larger, adjust quality if needed)

## Key Implementation Details

### Image Handling Strategy

1. **Detect images** in the container
2. **Separate images** from text content
3. **Render images individually** - one canvas per image
4. **Place each image on its own page** - scaled to 85% of page
5. **Render text content** separately and paginate normally

### Canvas Options

```typescript
{
    scale: 1.2,              // Lower for images to reduce file size
    useCORS: true,           // Critical for cross-origin images
    allowTaint: true,        // Allow cross-origin images
    backgroundColor: '#ffffff',
    logging: false,
    imageTimeout: 15000,
    letterRendering: true,
    width: element.scrollWidth,
    height: element.scrollHeight,
}
```

### PDF Options

```typescript
{
    unit: 'pt',              // Points (matches A4 dimensions)
    format: 'a4',
    orientation: 'portrait',
    compress: false,         // Keep false for better quality
}
```

## Potential Challenges & Solutions

### Challenge 1: Large Canvas Size

**Problem**: Very tall content may exceed canvas size limits
**Solution**:

-   Use chunking (already implemented)
-   Process in smaller sections
-   Use lower scale for very large content

### Challenge 2: Image Loading

**Problem**: Images may not be loaded when canvas is created
**Solution**:

-   Keep `ensureAllImagesLoaded` function
-   Wait for all images before generating canvas
-   Add retry logic if needed

### Challenge 3: Performance

**Problem**: Multiple canvas renders may be slower
**Solution**:

-   Process images in parallel where possible
-   Use lower scale for non-critical content
-   Consider web workers for heavy processing

### Challenge 4: File Size

**Problem**: JPEG quality may create large files
**Solution**:

-   Adjust quality (0.95 for images, 0.98 for text)
-   Use PNG for text, JPEG for images
-   Compress PDF if needed

## Rollback Plan

If issues arise:

1. Keep html2pdf.js import commented out
2. Can quickly revert by uncommenting old code
3. Both libraries can coexist during migration

## Timeline Estimate

-   **Phase 1**: 30 minutes (install, update imports)
-   **Phase 2**: 2-3 hours (create new functions)
-   **Phase 3**: 1-2 hours (update existing code)
-   **Phase 4**: 30 minutes (verify geotag links)
-   **Phase 5**: 2-3 hours (testing, refinement)

**Total**: ~6-9 hours

## Success Criteria

✅ Images appear correctly in PDF
✅ Images are on their own pages (not split)
✅ Images are scaled to 85% of page
✅ Text content renders correctly
✅ Geotag links still work
✅ PDF file size is reasonable
✅ Performance is acceptable

## Next Steps

1. Review and approve this plan
2. Create feature branch: `migrate-html2canvas`
3. Begin Phase 1 implementation
4. Test incrementally after each phase
5. Merge when all tests pass


