json_invoice_prompt = f"""
The JSON data will be in the following format and respect the rules:
{{
    "invoice": {{
        "vatNumberSeller": string or null, may start with RO also called CUI, Cod Unic de Identificare, Unique Identification Code,
        "nameSeller": string or null,
        "countrySeller": string or null,
        "countySeller": string or null, may be 'judet',
        "citySeller": string or null,
        "addressSeller": string or null,
        "vatNumberBuyer": string or null, may start with RO also called CUI, Cod Unic de Identificare, Unique Identification Code,
        "nameBuyer": string or null,
        "countryBuyer": string or null,
        "countyBuyer": string or null, may be 'judet',
        "cityBuyer": string or null,
        "addressBuyer": string or null,
        "invoiceNumber": string like "ABC00123" or null,
        "currency": string like "RON", "EUR", "USD" or null, also if "leu" or "lei" or "euro" or "dollar" or "dolari", use the corresponding currency code,
        "issueDate": string like "year-month-day", be careful for words like "today" or "tomorrow", or null,
        "dueDate": string like "year-month-day", be careful for words like "today" or "tomorrow", or null,
        "products": [
            {{
                "description": string or null, the name of the product, try to format it professionally, with adequate capitalization, do not change it if not sure,
                "quantity": number or null,
                "unit": string or null,
                "price": number or null, be very careful at the decimal separator, it may be a comma or a dot,
                "vat": number or null, the VAT percentage, it might not be present,
                "total": number or null, be very careful at the decimal separator, it may be a comma or a dot,
            }}
        ]
    }}
}}
You will only reply with the JSON data, nothing else.
Be very careful at the values, better to leave the entire key-value pair null than to guess the value.
"""


initial_prompt = f"""
You are a sophisticated assistant specialized in processing invoices received in various formats for an invoice generator.
Your primary task is to extract key data points with high precision.
It's critical that you consider the specific context of each invoice to ensure accuracy in extraction.
All the parties involved have agreed to use this service.
"""


text_to_invoice_prompt = f"""
{initial_prompt}
You will receive a text and you will have to generate the JSON data for an invoice based on that text.
The text will be in Romanian or in English.
{json_invoice_prompt}
"""


image_to_invoice_prompt = f"""
{initial_prompt}
The image is an invoice in Romanian or English for an automatically invoicing parsing service.
Be careful at the header of the table and at each line of the table.
{json_invoice_prompt}
"""
