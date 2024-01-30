import {
    WebContainer,
} from '@webcontainer/api';

import {
    files,
} from '../data/files';



class WebContainerRunner {
    webcontainerInstance: WebContainer | null = null;


    constructor() {
    }


    private async installDependencies() {
        if (!this.webcontainerInstance) {
            return;
        }

        const installProcess = await this.webcontainerInstance.spawn('npm', ['install']);
        installProcess.output.pipeTo(new WritableStream({
            write(data) {
                console.log(data);
            }
        }));

        return installProcess.exit;
    }


    public async load() {
        try {
            if (this.webcontainerInstance) {
                return true;
            }

            this.webcontainerInstance = await WebContainer.boot();
            await this.webcontainerInstance.mount(files);

            const exitCodeInstall = await this.installDependencies();
            if (exitCodeInstall !== 0) {
                return false;
            }

            return true;
        } catch (error) {
            return false;
        }
    }

    public destroy() {
        if (!this.webcontainerInstance) {
            return;
        }

        this.webcontainerInstance.teardown();
        this.webcontainerInstance = null;
    }

    public async writeData<D>(
        content: D,
    ) {
        if (!this.webcontainerInstance) {
            return;
        }

        await this.webcontainerInstance.fs.writeFile('/data.json', JSON.stringify(content));
    }

    public async startNodePHPServer(
        extractor: (value: string) => void,
    ) {
        if (!this.webcontainerInstance) {
            return;
        }

        const startProcess = await this.webcontainerInstance.spawn('npm', ['run', 'start']);
        startProcess.output.pipeTo(new WritableStream({
            write(data) {
                try {
                    const result = JSON.parse(data);
                    if (result.status) {
                        extractor(result.data);
                    }
                } catch(error) {
                    return;
                }
            }
        }));

        return startProcess.exit;
    }
}


const webContainerRunner = new WebContainerRunner();


export default webContainerRunner;
