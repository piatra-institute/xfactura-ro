import jsPDF from 'jspdf';
import autoTable, {
    RowInput,
} from 'jspdf-autotable';

import {
    Invoice,
    Company,
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


const composeCompanyTableBody = (
    data: Company,
) => {
    const body: RowInput[] = [
        {
            content: data.name,
        },
        {
            content: data.vatNumber,
        },
        {
            content: data.address,
        },
        {
            content: `${data.city}, ${data.county}, ${data.country}`,
        },
    ];

    if (data.contact) {
        body.push({
            content: data.contact,
        });
    }
    if (data.IBAN) {
        body.push({
            content: data.IBAN,
        });
    }

    return body;
}


const drawSeller = async (
    doc: jsPDF,
    data: Invoice,
    font: string,
) => {
    doc.setFont(font).setFontSize(12);
    doc.text('Furnizor', 50, 50);

    autoTable(doc, {
        startY: 57,
        margin: { left: 47 },
        tableWidth: 200,
        styles: {
            font,
            fontSize: 10,
            cellPadding: 3,
        },
        theme: 'plain',
        head: [],
        body: composeCompanyTableBody(data.seller),
    });
}


const drawBuyer = async (
    doc: jsPDF,
    data: Invoice,
    font: string,
) => {
    doc.setFont(font).setFontSize(12);
    doc.text('Cumpărător', 390, 50);

    autoTable(doc, {
        startY: 57,
        margin: { left: 387 },
        tableWidth: 200,
        styles: {
            font,
            fontSize: 10,
            cellPadding: 3,
        },
        theme: 'plain',
        head: [],
        body: composeCompanyTableBody(data.buyer),
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
            formatNumber(product.price).replace('RON', '').trim(),
            formatNumber(product.price * product.vatRate / 100).replace('RON', '').trim(),
            formatNumber(productTotal).replace('RON', '').trim(),
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
            halign: 'center',
        },
        columnStyles: {
            0: {
                cellWidth: 220,
            },
            1: {
                cellWidth: 60,
                halign: 'center',
            },
            2: {
                cellWidth: 90,
                halign: 'right',
            },
            3: {
                cellWidth: 70,
                halign: 'right',
            },
            4: {
                halign: 'right',
            },
        },
    });


    const filename = `xfactura_${data.metadata.number}_${data.buyer.name.replace(/\s/, '')}.pdf`;
    doc.save(filename);
}
