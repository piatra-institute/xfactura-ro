import type {
    Request,
    Response,
} from 'express';



export default async function handler(
    _request: Request,
    response: Response,
) {
    response.send(`
<!DOCTYPE html>
    <html lang="en">
    <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>xfactura.ro API</title>
    <style>
        body {
            background-color: black;
            margin: 0;
            padding: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            font-family: sans-serif;
        }
        .xfactura {
            color: white;
            font-size: 24px;
            text-align: center;
        }
    </style>
    </head>
    <body>
    <div class="xfactura">xfactura.ro API</div>
    </body>
</html>
    `);
}
