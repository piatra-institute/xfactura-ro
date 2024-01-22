import express from 'express';

import {
    login,
} from './handlers';



const port = 8089;
const app = express();

app.get('/login', login);

app.listen(port, () => {
    console.log(`Server started on ${port}`);
});
