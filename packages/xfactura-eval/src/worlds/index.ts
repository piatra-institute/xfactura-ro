import type { World } from '../world/schema';
import { pfaRealSystem } from './pfa-real-system';
import { srlMicroServices } from './srl-micro-services';

/** Every world, by profile. */
export const worlds: World[] = [srlMicroServices, pfaRealSystem];
