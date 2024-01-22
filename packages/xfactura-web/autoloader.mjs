import fs from 'node:fs';
import path from 'node:path';



const INPUT = './node-php';
const OUTPUT = 'data/files.ts';
const exportLine = 'export const files = ';


const getAllFiles = (
    rootPath,
    options,
    contents,
) => {
    const files = fs.readdirSync(rootPath);

    let contentsIn = contents || {};

    files.forEach((file) => {
        if (options.exclude.length > 0) {
            for (const excluder of options.exclude) {
                if (file.includes(excluder)) {
                    return;
                }
            }
        }

        const filepath = path.join(
            rootPath,
            path.sep,
            file,
        );

        if (
            fs.statSync(filepath).isDirectory()
        ) {
            contents = getAllFiles(
                filepath,
                options,
            );

            contentsIn[file] = {
                directory: contents,
            };
        } else {
            const buffer = fs.readFileSync(filepath);
            contentsIn[file] = {
                file: {
                    contents: buffer.toString(),
                },
            };
        }
    });

    return contentsIn;
}

const content = getAllFiles(
    INPUT,
    {
        exclude: [
            '.github',
            'docs',
            'tests',
            '.editorconfig',
            '.gitattributes',
            '.gitignore',
            'CONTRIBUTING.md',
            'LICENSE',
            'mkdocs.yml',
            'README.md',
        ],
    },
);


fs.writeFileSync(
    OUTPUT,
    `${exportLine}${JSON.stringify(content, null, 2)}`,
);
