import {
    PDFDocument,
    PDFPage,
    PDFFont,
    rgb,
} from 'pdf-lib';

import fontkit from '@pdf-lib/fontkit';

import {
    Invoice,
} from '@/data';

import {
    downloadBlob,
} from '@/logic/utilities';

import {
    formatNumber,
} from '@/logic/utilities';



const drawText = (
    page: PDFPage,
    text: string,
    x: number,
    y: number,
    size = 10,
    font: PDFFont,
    color = rgb(0, 0, 0),
) => {
    page.drawText(text, { x, y, size, font, color });
}


const drawSeller = async (
    data: Invoice,
    page: PDFPage,
    font: PDFFont,
    margin: number,
    currentY: number,
) => {
    drawText(page, `Furnizor`, margin, currentY, 12, font);
    currentY -= 20;
    drawText(page, `${data.seller.name}`, margin, currentY, 10, font);
    currentY -= 20;
    drawText(page, `${data.seller.vatNumber}`, margin, currentY, 10, font);
    currentY -= 20;
    drawText(page, `${data.seller.address}`, margin, currentY, 10, font);
    currentY -= 15;
    drawText(page, `${data.seller.city}, ${data.seller.county}, ${data.seller.country}`, margin, currentY, 10, font);
    currentY -= 20;

    if (data.seller.contact) {
        drawText(page, `${data.seller.contact}`, margin, currentY, 10, font);
        currentY -= 20;
    } else {
        currentY -= 5;
    }

    return currentY;
}


const drawBuyer = async (
    data: Invoice,
    page: PDFPage,
    font: PDFFont,
    margin: number,
    currentY: number,
) => {
    const currentX = margin + 250;

    drawText(page, `Cumpărător`, currentX, currentY, 12, font);
    currentY -= 20;
    drawText(page, `${data.buyer.name}`, currentX, currentY, 10, font);
    currentY -= 20;
    drawText(page, `${data.buyer.vatNumber}`, currentX, currentY, 10, font);
    currentY -= 20;
    drawText(page, `${data.buyer.address}`, currentX, currentY, 10, font);
    currentY -= 15;
    drawText(page, `${data.buyer.city}, ${data.buyer.county}, ${data.buyer.country}`, currentX, currentY, 10, font);
    currentY -= 30;

    if (data.buyer.contact) {
        drawText(page, `${data.buyer.contact}`, margin, currentY, 10, font);
        currentY -= 20;
    } else {
        currentY -= 5;
    }

    return currentY;
}


const drawMetadata = async (
    data: Invoice,
    page: PDFPage,
    font: PDFFont,
    margin: number,
    currentY: number,
) => {
    const currentX = margin + 100;

    currentY -= 20;

    drawText(page, `Număr`, currentX, currentY, 12, font);
    drawText(page, `Emitere`, currentX + 80, currentY, 12, font);
    drawText(page, `Scadență`, currentX + 150, currentY, 12, font);
    drawText(page, `Moneda`, currentX + 240, currentY, 12, font);
    currentY -= 20;
    drawText(page, `${data.metadata.number}`, currentX, currentY, 10, font);
    drawText(page, `${new Date(data.metadata.issueDate).toLocaleDateString()}`, currentX + 80, currentY, 10, font);
    drawText(page, `${new Date(data.metadata.dueDate).toLocaleDateString()}`, currentX + 150, currentY, 10, font);
    drawText(page, `${data.metadata.currency}`, currentX + 240, currentY, 10, font);
    currentY -= 20;

    currentY -= 50;

    return currentY;
}


const drawInvoiceHeaders = async (
    data: Invoice,
    page: PDFPage,
    font: PDFFont,
    margin: number,
    currentY: number,
) => {
    const headers = ["Nume", "Cantitate", "Preț", "TVA", "Total"];
    const columnWidths = [100, 70, 70, 70, 70];

    let currentX = margin;
    headers.forEach((header, index) => {
        drawText(page, header, currentX, currentY, 12, font, rgb(0, 0.53, 0.71));
        currentX += columnWidths[index] + 10; // Adding some space between columns
    });
    currentY -= 20;

    return currentY;
}


const drawInvoiceLines = async (
    data: Invoice,
    page: PDFPage,
    font: PDFFont,
    margin: number,
    currentY: number,
) => {
    const columnWidths = [100, 70, 70, 70, 70];

    data.products.forEach((product) => {
        const productTotal = product.vatIncluded
            ? product.price * product.quantity
            : product.price * product.quantity * (1 + product.vatRate / 100);

        const line = [
            product.name,
            product.quantity.toString(),
            formatNumber(product.price),
            formatNumber(product.price * product.vatRate / 100),
            formatNumber(productTotal),
        ];

        let currentX = margin;
        line.forEach((text, index) => {
            drawText(page, text, currentX, currentY, 10, font);
            currentX += columnWidths[index] + 10;
        });
        currentY -= 20;
    });

    return currentY;
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

    const margin = 50;
    const initialY = 800;
    let currentY = initialY;

    currentY = await drawSeller(data, page, font, margin, initialY);
    currentY = await drawBuyer(data, page, font, margin, initialY);

    currentY = await drawMetadata(data, page, font, margin, currentY);
    currentY = await drawInvoiceHeaders(data, page, font, margin, currentY);
    currentY = await drawInvoiceLines(data, page, font, margin, currentY);

    const pdfBytes = await pdfDoc.save();
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const filename = `xfactura_${data.metadata.number}.pdf`;
    downloadBlob(filename, blob);
}
