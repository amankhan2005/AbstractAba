import { HomePage } from '@/pages/HomePage.jsx';
import { ContactPage } from '@/pages/ContactPage.jsx';
import { PrivacyPolicyPage } from '@/pages/PrivacyPolicyPage.jsx';
import { TermsPage } from '@/pages/TermsPage.jsx';
import { NotFoundPage } from '@/pages/NotFoundPage.jsx';

/**
 * Public website routes. Every page is open to everyone; "Sign In" leaves this
 * application for the existing web panel login (see config/env.js).
 */
export const routes = [
  { path: '/', element: <HomePage /> },
  { path: '/contact', element: <ContactPage /> },
  { path: '/privacy-policy', element: <PrivacyPolicyPage /> },
  { path: '/terms-and-conditions', element: <TermsPage /> },
  { path: '*', element: <NotFoundPage /> },
];
