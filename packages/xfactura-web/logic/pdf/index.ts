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

    autoTable(doc, {
        startY: 60,
        margin: { left: 45 },
        tableWidth: 200,
        styles: {
            font,
            fontSize: 10,
        },
        theme: 'plain',
        head: [],
        body: [
            {
                content: data.seller.name,
            },
            {
                content: data.seller.vatNumber,
            },
            {
                content: data.seller.address,
            },
            {
                content: `${data.seller.city}, ${data.seller.county}, ${data.seller.country}`,
            },
        ],
    });
}


const drawBuyer = async (
    doc: jsPDF,
    data: Invoice,
    font: string,
) => {
    doc.setFont(font).setFontSize(12);
    doc.text('Cumpărător', 350, 50);

    autoTable(doc, {
        startY: 60,
        margin: { left: 345 },
        tableWidth: 200,
        styles: {
            font,
            fontSize: 10,
        },
        theme: 'plain',
        head: [],
        body: [
            {
                content: data.buyer.name,
            },
            {
                content: data.buyer.vatNumber,
            },
            {
                content: data.buyer.address,
            },
            {
                content: `${data.buyer.city}, ${data.buyer.county}, ${data.buyer.country}`,
            },
        ],
    });
}


const drawMetadata = async (
    doc: jsPDF,
    data: Invoice,
    font: string,
) => {
    doc.setFont(font).setFontSize(20);
    doc.text('Factură', 260, 180);

    doc.setFont(font).setFontSize(10);
    autoTable(doc, {
        startY: 195,
        margin: { left: 230 },
        tableWidth: 130,
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
                    styles: {
                        halign: 'right',
                    },
                },
            ],
            [
                {
                    content: `Emitere`,
                },
                {
                    content: `${new Date(data.metadata.issueDate).toLocaleDateString()}`,
                    styles: {
                        halign: 'right',
                    },
                },
            ],
            [
                {
                    content: `Scadență`,
                },
                {
                    content: `${new Date(data.metadata.dueDate).toLocaleDateString()}`,
                    styles: {
                        halign: 'right',
                    },
                },
            ],
            [
                {
                    content: `Moneda`,
                },
                {
                    content: `${data.metadata.currency}`,
                    styles: {
                        halign: 'right',
                    },
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
        startY: 290,
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
