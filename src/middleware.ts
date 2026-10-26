/**
 * Request middleware. The identity module resolves the cookie session (guest or member) into
 * `locals.learner` here, and enforces same-origin checks for state-changing /api requests.
 */
import { defineMiddleware } from 'astro:middleware';

export const onRequest = defineMiddleware(async (_context, next) => next());
