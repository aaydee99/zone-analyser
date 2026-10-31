import 'server-only';
import type { CheckId } from '../monitor-types';
import type { CheckDef } from './common';
import { posture } from './posture';
import { certificates } from './certificates';
import { governance } from './governance';
import { drift } from './drift';
import { alerts } from './alerts';
import { availability } from './availability';
import { platform } from './platform';
import { appsec } from './appsec';
import { pagerules } from './pagerules';
import { dns } from './dns';
import { loadbalancing } from './loadbalancing';
import { lists } from './lists';

export const DEFS: Record<CheckId, CheckDef> = { posture, certificates, governance, drift, alerts, availability, platform, appsec, pagerules, dns, loadbalancing, lists };
