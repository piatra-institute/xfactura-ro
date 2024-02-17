import { v4 as uuid } from 'uuid';



export const NewUser = (
    email: string,
    name: string,
    picture: string,
) => ({
    id: uuid(),
    createdAt: new Date().toISOString(),
    email,
    name,
    picture,
    payments: JSON.stringify([]),
    intelligentActs: 0,
    freeIntelligentActs: 5,
});
