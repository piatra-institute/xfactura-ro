import {
    useGoogleLogin,
    CodeResponse as GoogleCodeResponse,
} from '@react-oauth/google';

import {
    User,

    ENVIRONMENT,
} from '@/data';

import useStore from '@/store';

import LinkButton from '../LinkButton';
import Subtitle from '../Subtitle';



export default function LoginScreen({
    atLoginSuccess,
    back,
} : {
    atLoginSuccess: () => void;
    back: () => void,
}) {
    const {
        setUser,
    } = useStore();


    // #region handlers
    const loginSuccess = (
        data: User,
    ) => {
        setUser(data);

        atLoginSuccess();
    }

    const googleSuccessLogin = (
        codeResponse: Omit<GoogleCodeResponse, 'error' | 'error_description' | 'error_uri'>,
    ) => {
        fetch(ENVIRONMENT.API_DOMAIN + '/google-login', {
            method: 'POST',
            credentials: 'include',
            mode: 'cors',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(codeResponse),
        })
            .then(async (response) => {
                const request = await response.json();
                if (!request.status) {
                    return;
                }

                loginSuccess(request.data);
            })
            .catch((error) => {
                console.log('error', error);
            });
    }
    const googleErrorLogin = () => {
        console.log('Login Failed');
    }
    const googleLogin = useGoogleLogin({
        flow: 'auth-code',
        onSuccess: (codeResponse) => googleSuccessLogin(codeResponse),
        onError: () => googleErrorLogin(),
        scope: 'https://www.googleapis.com/auth/drive.file',
    });


    const appleSuccessLogin = () => {
        atLoginSuccess();
    }
    const appleErrorLogin = () => {
        console.log('Login Failed');
    }
    // #endregion handlers


    return (
        <>
            <div
                className="m-auto"
            >
                <Subtitle
                    text={"logare"}
                />
            </div>

            <LinkButton
                text="logare prin Google"
                onClick={() => {
                    googleLogin();
                }}
                icon="/assets/google-logo.png"
            />

            <LinkButton
                text="logare prin Apple"
                onClick={() => {
                    appleSuccessLogin();
                }}
                icon="/assets/apple-logo.png"
            />

            <LinkButton
                text="înapoi"
                onClick={() => {
                    back();
                }}
                centered={true}
            />
        </>
    );
}
