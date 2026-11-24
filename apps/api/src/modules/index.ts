import type { Router } from 'express';
import { auth } from './auth/routes';
import { orgs } from './organizations/routes';
import { members } from './members/routes';

export const routers: Router[] = [auth.router, orgs.router, members.router];
