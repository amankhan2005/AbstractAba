import { Link } from 'react-router-dom';
import { PLATFORM_BRAND } from '@aba1on1/schemas';
import { LegalPage } from '@/components/LegalPage.jsx';

const { productName: PRODUCT, providerName: PROVIDER, supportEmail: EMAIL } = PLATFORM_BRAND;

/**
 * Terms & Conditions for the public website and the platform. Makes clear that
 * WebieApp Solutions LLC provides software only; customer organizations are
 * separate entities responsible for their own services and data.
 */
const SECTIONS = [
  {
    id: 'agreement',
    title: 'About these terms',
    body: [
      `These Terms & Conditions govern your use of the ${PRODUCT} website and the ${PRODUCT} platform, provided by ${PROVIDER} (“we”, “us”, “our”). By using the website or the platform, you agree to these terms.`,
      'If your organization has a separate written agreement with us (such as a subscription or onboarding agreement), that agreement governs your organization’s use of the platform and takes precedence over these terms where they differ.',
    ],
  },
  {
    id: 'roles',
    title: 'Our role and your organization’s role',
    body: [
      `${PROVIDER} provides practice management software. We are not a healthcare provider, do not provide ABA or other clinical services, and do not make clinical, billing or employment decisions for any organization.`,
      'Each organization that uses the platform (a “customer organization”) is a separate entity. It is solely responsible for the services it delivers, the professional judgment of its staff, and the accuracy and lawfulness of the information it enters.',
    ],
  },
  {
    id: 'website-use',
    title: 'Use of the website',
    body: [
      'You may use the public website to learn about our software and to contact us. You agree to provide accurate information when you submit an inquiry and not to submit client health information or other sensitive personal information through the contact form.',
      'Website content is provided for general information and may change without notice. It is not legal, clinical, billing or compliance advice.',
    ],
  },
  {
    id: 'platform-use',
    title: 'Use of the platform',
    body: [
      'Access to the platform is available to organizations that have completed onboarding with us and to users those organizations authorize. Features available to a user depend on the organization’s subscription and the user’s assigned role.',
    ],
  },
  {
    id: 'accounts',
    title: 'Account responsibility',
    body: [
      {
        list: [
          'Keep your sign-in credentials confidential and do not share your account.',
          'Use a strong password and change it promptly if you believe it has been compromised.',
          `Tell your organization’s administrator, or contact us at ${EMAIL}, if you suspect unauthorized access.`,
          'You are responsible for activity that takes place under your account.',
        ],
      },
    ],
  },
  {
    id: 'authorized-access',
    title: 'Authorized access',
    body: [
      'You may access only the organizations, workspaces and information you have been authorized to access. You must not attempt to access another organization’s data, bypass role or permission controls, or use another person’s account.',
    ],
  },
  {
    id: 'customer-responsibilities',
    title: 'Customer organization responsibilities',
    body: [
      'Customer organizations are responsible for:',
      {
        list: [
          'Inviting only appropriate users and assigning roles that match their responsibilities',
          'Removing or updating access when a user’s role changes or they leave the organization',
          'The accuracy of client, staff, session, billing and payroll information entered into the platform',
          'Reviewing billing and payroll outputs before relying on or submitting them',
          'Obtaining any consents and meeting the legal, professional and payer requirements that apply to their services',
        ],
      },
    ],
  },
  {
    id: 'acceptable-use',
    title: 'Acceptable use',
    body: [
      'You agree not to:',
      {
        list: [
          'Use the website or platform for any unlawful, fraudulent or harmful purpose',
          'Upload malicious code or interfere with the operation or security of the service',
          'Probe, scan or test the vulnerability of the service without our written permission',
          'Scrape, copy or resell the service, or use it to build a competing product',
          'Send spam or unsolicited messages through the contact form or the platform',
        ],
      },
      'We may suspend access that we reasonably believe violates these terms or puts the service or other users at risk.',
    ],
  },
  {
    id: 'intellectual-property',
    title: 'Intellectual property',
    body: [
      `The website, the platform, and their software, design, text and branding, including the ${PRODUCT} name and logo, are owned by ${PROVIDER} or its licensors and are protected by intellectual property laws. These terms do not transfer any ownership rights to you.`,
      'Customer organizations retain their rights in the data they enter into the platform.',
    ],
  },
  {
    id: 'availability',
    title: 'Service availability',
    body: [
      'We work to keep the website and platform available and reliable, but we do not guarantee uninterrupted or error-free operation. The service may be unavailable during maintenance, updates or events outside our control. We may change, add or remove features over time.',
    ],
  },
  {
    id: 'third-party-services',
    title: 'Third-party services',
    body: [
      'The service relies on third-party providers, such as email delivery, image storage and hosting providers. We are not responsible for services, websites or content provided by third parties, and your use of them may be subject to their own terms.',
    ],
  },
  {
    id: 'liability',
    title: 'Disclaimers and limitation of liability',
    body: [
      'Except as expressly stated in a written agreement with us, the website and platform are provided “as is” and “as available”, without warranties of any kind, whether express or implied, to the fullest extent permitted by law.',
      `To the fullest extent permitted by law, ${PROVIDER} will not be liable for any indirect, incidental, special, consequential or punitive damages, or for any loss of profits, revenue, data or goodwill, arising from or related to your use of the website or platform. Clinical, billing, payroll and employment decisions remain the responsibility of the customer organization.`,
      'Some jurisdictions do not allow certain limitations, so some of these limitations may not apply to you.',
    ],
  },
  {
    id: 'termination',
    title: 'Suspension and termination',
    body: [
      'You may stop using the website at any time. A customer organization’s access to the platform may end in accordance with its agreement with us. We may suspend or terminate access for violations of these terms, non-payment under an applicable agreement, or to protect the service and its users.',
    ],
  },
  {
    id: 'changes',
    title: 'Changes to these terms',
    body: [
      'We may update these terms from time to time. When we do, we will revise the “Last updated” date at the top of this page. Continued use of the website or platform after changes take effect means you accept the updated terms.',
    ],
  },
  {
    id: 'contact',
    title: 'Contact',
    body: [
      <p key="c">
        Questions about these terms can be sent to {PROVIDER} at <a href={`mailto:${EMAIL}`}>{EMAIL}</a> or through
        our <Link to="/contact">contact page</Link>.
      </p>,
    ],
  },
];

export function TermsPage() {
  return (
    <LegalPage
      title="Terms & Conditions"
      intro={`The terms that apply to the ${PRODUCT} website and platform.`}
      sections={SECTIONS}
    />
  );
}

export default TermsPage;
