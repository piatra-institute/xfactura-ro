json_invoice_prompt = f"""
The JSON data will be in the following format:
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
        "currency": string like "RON" or null,
        "issueDate": string like "year-month-day", be careful for words like "today" or "tomorrow", or null,
        "dueDate": string like "year-month-day", be careful for words like "today" or "tomorrow", or null,
        "products": [
            {{
                "description": string or null,
                "quantity": number or null,
                "unit": string or null,
                "price": number or null,
                "vat": number or null,
                "total": number or null
            }}
        ]
    }}
}}
You will only reply with the JSON data, nothing else.
Be very careful at the values, better to leave the entire key-value pair null than to guess the value.
"""


initial_prompt = f"""
You are a helper for an invoice generator.
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
