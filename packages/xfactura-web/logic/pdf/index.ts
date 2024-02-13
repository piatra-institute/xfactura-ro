import {
    PDFDocument,
    rgb,
} from 'pdf-lib';

import fontkit from '@pdf-lib/fontkit';

import {
    Invoice,
} from '@/data';

import {
    downloadBlob,
} from '@/logic/utilities';



const drawText = (
    page: any,
    text: any,
    x: number,
    y: number,
    size = 10,
    font: any,
    color = rgb(0, 0, 0),
) => {
    page.drawText(text, { x, y, size, font, color });
}

export const generatePdf = async (
    data: Invoice,
) => {
    const pdfDoc = await PDFDocument.create();

    pdfDoc.registerFontkit(fontkit);
    const fontBytes = await fetch('/assets/NotoSans-Regular.ttf').then((res) => res.arrayBuffer());
    const font = await pdfDoc.embedFont(fontBytes);

    const A4 = [595, 842] as [number, number];
    const page = pdfDoc.addPage(A4);

    // Basic layout setup
    const margin = 50;
    const initialY = 700;
    let currentY = initialY;


    // Draw Seller Information
    drawText(page, `Furnizor: ${data.seller.name}`, margin, currentY, 12, font);
    currentY -= 20;
    drawText(page, `${data.seller.address}, ${data.seller.city}, ${data.seller.county}, ${data.seller.country}`, margin, currentY, 10, font);
    currentY -= 15;
    if (data.seller.contact) {
        drawText(page, `Contact: ${data.seller.contact}`, margin, currentY, 10, font);
        currentY -= 20;
    } else {
        currentY -= 5;
    }


    // Draw Buyer Information
    drawText(page, `Cumpărător: ${data.buyer.name}`, margin, currentY, 12, font);
    currentY -= 20;
    drawText(page, `${data.buyer.address}, ${data.buyer.city}, ${data.buyer.county}, ${data.buyer.country}`, margin, currentY, 10, font);
    currentY -= 30; // Extra space before the invoice lines


    // Draw Invoice Headers
    const headers = ["Nume", "Cantitate", "Preț", "TVA", "Total"];
    const columnWidths = [100, 70, 70, 70, 70];
    let currentX = margin;
    headers.forEach((header, index) => {
        drawText(page, header, currentX, currentY, 12, font, rgb(0, 0.53, 0.71));
        currentX += columnWidths[index] + 10; // Adding some space between columns
    });
    currentY -= 20;


    // Draw Invoice Lines
    data.products.forEach((product) => {
        const productTotal = product.vatIncluded ? product.price * product.quantity :
            product.price * product.quantity * (1 + product.vatRate);
        const line = [
            product.name,
            product.quantity.toString(),
            `$${product.price.toFixed(2)}`,
            `${(product.vatRate * 100).toFixed(0)}%`,
            `$${productTotal.toFixed(2)}`
        ];

        currentX = margin;
        line.forEach((text, index) => {
            drawText(page, text, currentX, currentY, 10, font);
            currentX += columnWidths[index] + 10;
        });
        currentY -= 20;
    });


    // Generating PDF and triggering download
    const pdfBytes = await pdfDoc.save();
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const filename = `xfactura_${data.metadata.number}.pdf`;
    downloadBlob(filename, blob);
}
