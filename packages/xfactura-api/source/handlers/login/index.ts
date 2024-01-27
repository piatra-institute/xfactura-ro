import {
    Request,
    Response,
} from 'express';



const login = (
    request: Request,
    response: Response,
) => {
    response.send('login');
}



export default login;
