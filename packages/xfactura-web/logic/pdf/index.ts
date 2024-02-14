import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

import {
    Invoice,
} from '@/data';

import {
    formatNumber,
} from '@/logic/utilities';



function arrayBufferToBase64(
    buffer: ArrayBuffer,
) {
    let binary = '';
    const bytes = new Uint8Array(buffer);

    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }

    return btoa(binary);
}


const drawSeller = async (
    doc: jsPDF,
    data: Invoice,
    font: string,
) => {
    doc.setFont(font).setFontSize(12);
    doc.text('Furnizor', 50, 50);
    doc.setFontSize(10);
    doc.text(data.seller.name, 50, 70);
    doc.text(data.seller.vatNumber, 50, 90);
    doc.text(data.seller.address, 50, 110);
    doc.text(`${data.seller.city}, ${data.seller.county}, ${data.seller.country}`, 50, 130);
}


const drawBuyer = async (
    doc: jsPDF,
    data: Invoice,
    font: string,
) => {
    doc.setFont(font).setFontSize(12);
    doc.text('Cumpărător', 300, 50);
    doc.setFontSize(10);
    doc.text(data.buyer.name, 300, 70);
    doc.text(data.buyer.vatNumber, 300, 90);
    doc.text(data.buyer.address, 300, 110);
    doc.text(`${data.buyer.city}, ${data.buyer.county}, ${data.buyer.country}`, 300, 130);
}


const drawMetadata = async (
    doc: jsPDF,
    data: Invoice,
    font: string,
) => {
    doc.setFont(font).setFontSize(20);
    doc.text('Factură', 250, 170);

    doc.setFont(font).setFontSize(10);
    autoTable(doc, {
        startY: 190,
        margin: { left: 210 },
        tableWidth: 150,
        styles: {
            font,
            fontSize: 8,
        },
        head: [],
        body: [
            [
                {
                    content: `Număr`,
                },
                {
                    content: `${data.metadata.number}`,
                },
            ],
            [
                {
                    content: `Emitere`,
                },
                {
                    content: `${new Date(data.metadata.issueDate).toLocaleDateString()}`,
                },
            ],
            [
                {
                    content: `Scadență`,
                },
                {
                    content: `${new Date(data.metadata.dueDate).toLocaleDateString()}`,
                },
            ],
            [
                {
                    content: `Moneda`,
                },
                {
                    content: `${data.metadata.currency}`,
                },
            ],
        ],
    });
}


export const generatePdf = async (
    data: Invoice,
) => {
    const doc = new jsPDF({
        orientation: 'portrait',
        unit: 'pt',
        format: 'a4',
    });


    const fontName = 'NotoSans-Regular';
    const fontFile = fontName + '.ttf';
    const fontBytes = await fetch(`/assets/${fontFile}`)
        .then((res) => res.arrayBuffer())
        .catch((_) => {});
    if (!fontBytes) {
        return;
    }
    doc.addFileToVFS(fontFile, arrayBufferToBase64(fontBytes));
    doc.addFont(fontFile, fontName, 'normal');
    doc.setFont(fontName);


    await drawSeller(doc, data, fontName);
    await drawBuyer(doc, data, fontName);
    await drawMetadata(doc, data, fontName);


    const headers = ['Nume', 'Cantitate', 'Preț', 'TVA', 'Total'];
    const body = data.products.map((product) => {
        const productTotal = product.vatIncluded
            ? product.price * product.quantity
            : product.price * product.quantity * (1 + product.vatRate / 100);

        return [
            product.name,
            product.quantity,
            formatNumber(product.price).replace(' RON', ''),
            product.vatRate,
            formatNumber(productTotal).replace(' RON', ''),
        ];
    });
    autoTable(doc, {
        head: [headers],
        body: [
            ...body,
        ],
        startY: 280,
        styles: {
            font: fontName,
        },
        headStyles: {
            fillColor: [190, 190, 190],
            textColor: [0, 0, 0],
            font: fontName,
        },
        columnStyles: {
            0: {
                cellWidth: 250,
            },
            1: {
                cellWidth: 60,
            },
        },
    });


    const filename = `xfactura_${data.metadata.number}_${data.buyer.name.replace(/\s/, '')}.pdf`;
    doc.save(filename);
}
