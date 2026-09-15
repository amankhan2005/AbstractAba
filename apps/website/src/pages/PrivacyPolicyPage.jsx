import { Link } from 'react-router-dom';
import { PLATFORM_BRAND } from '@aba1on1/schemas';
import { LegalPage } from '@/components/LegalPage.jsx';

const { productName: PRODUCT, providerName: PROVIDER, supportEmail: EMAIL } = PLATFORM_BRAND;

/**
 * Privacy Policy. Describes only practices the product actually has: the
 * contact form fields, the email provider used for delivery, image uploads,
 * sign-in cookies and local preferences. It separates the public website, the
 * software platform, and the data customer organizations enter.
 */
const SECTIONS = [
  {
    id: 'scope',
    title: 'Who we are and what this policy covers',
    body: [
      `${PRODUCT} is practice management software for ABA organizations, provided by ${PROVIDER} (“we”, “us”, “our”).`,
      'This policy explains how we handle information in three different contexts:',
      {
        list: [
          <span key="w"><strong>The public website</strong> — the pages you can visit without signing in, including the contact form.</span>,
          <span key="p"><strong>The {PRODUCT} platform</strong> — the software that organizations and their authorized users sign in to.</span>,
          <span key="c"><strong>Customer organization data</strong> — the client, staff, clinical, scheduling, billing and payroll information that an organization enters into the platform.</span>,
        ],
      },
      `${PROVIDER} is a software provider. We are not a healthcare provider and do not deliver ABA or other clinical services.`,
    ],
  },
  {
    id: 'website-information',
    title: 'Information submitted through the website',
    body: [
      'When you send an inquiry through our contact form, we collect the information you choose to provide:',
      { list: ['Full name', 'Company or organization name', 'Work email address', 'Phone number (optional)', 'Subject and message'] },
      'We record the date and time of your submission and the follow-up status of your inquiry. Please do not include client health information or other sensitive personal information in the contact form.',
    ],
  },
  {
    id: 'inquiry-use',
    title: 'How we use inquiry information',
    body: [
      'We use the information in your inquiry to:',
      {
        list: [
          'Respond to your questions and requests',
          'Discuss whether and how our software may fit your organization',
          'Keep a record of our communication with you',
          'Protect the contact form against spam and misuse',
        ],
      },
      'We do not sell the information you submit through the website.',
    ],
  },
  {
    id: 'communications',
    title: 'Communications',
    body: [
      'When you submit an inquiry, we send a notification to our team and a confirmation email to the address you provided. Our team may then contact you by email or, if you provided one, by phone about your inquiry.',
      'Users of the platform receive service emails related to their accounts, such as invitations, account activation and password reset messages. These are part of operating the service.',
    ],
  },
  {
    id: 'usage-information',
    title: 'Technical and usage information',
    body: [
      'Like most online services, our servers process technical information needed to deliver and protect the website and platform, such as IP address, browser type and request details. We use this information for security, rate limiting and troubleshooting.',
      'The contact form does not store your IP address or browser details with your inquiry.',
      'When you sign in to the platform, we use a secure, http-only cookie to maintain your session. The platform also stores a small number of preferences in your browser (for example, whether a session may be restored and display settings). We do not use advertising cookies.',
      'The website loads its typeface from Google Fonts, which means your browser requests font files from Google’s servers.',
    ],
  },
  {
    id: 'platform-data',
    title: 'Customer organization data in the platform',
    body: [
      'Organizations that use the platform decide what information to enter, which users may access it, and how it is used in their practice. For that information, the customer organization is responsible for its own obligations to its clients, staff and regulators, and we process the information on the organization’s behalf to provide the service.',
      'Where required, our handling of protected health information is governed by the agreements we enter into with each customer organization. If you are a client or family member of an organization that uses the platform, please contact that organization directly with questions or requests about your information.',
    ],
  },
  {
    id: 'security',
    title: 'Security',
    body: [
      'We use administrative, technical and organizational measures designed to protect information, including role-based access controls, separation of each organization’s data, authentication controls and restricted access to documents.',
      'No method of transmission or storage is completely secure, and we cannot guarantee absolute security. Organizations and users also play an important part — for example, by protecting passwords and granting access only to the people who need it.',
    ],
  },
  {
    id: 'third-parties',
    title: 'Third-party services',
    body: [
      'We rely on a limited number of service providers to operate the website and platform. They process information only as needed to provide their services to us:',
      {
        list: [
          <span key="resend"><strong>Resend</strong> — delivery of transactional emails, including inquiry notifications and confirmations.</span>,
          <span key="cloudinary"><strong>Cloudinary</strong> — storage and delivery of uploaded logo images.</span>,
          <span key="hosting"><strong>Cloud hosting and database providers</strong> — infrastructure used to run the service and store its data.</span>,
          <span key="fonts"><strong>Google Fonts</strong> — delivery of the typeface used on our pages.</span>,
        ],
      },
      'We may also disclose information if required by law, to protect the rights and safety of our users or others, or in connection with a business transfer such as a merger or acquisition.',
    ],
  },
  {
    id: 'email',
    title: 'Email',
    body: [
      `Emails we send about an inquiry come from ${PRODUCT} and are delivered through our email provider. If you would prefer that we not contact you further about an inquiry, write to us at ${EMAIL}.`,
    ],
  },
  {
    id: 'retention',
    title: 'Data retention',
    body: [
      'We keep inquiry information for as long as needed to respond to you, maintain a record of our communication, and meet legal or business requirements. You may ask us to delete your inquiry at any time, subject to any records we are required to keep.',
      'Customer organization data is retained according to the organization’s agreement with us and its instructions.',
    ],
  },
  {
    id: 'rights',
    title: 'Your choices and rights',
    body: [
      'Depending on where you live, you may have rights to request access to, correction of, or deletion of your personal information, or to object to certain processing. To make a request about information you submitted through our website, contact us using the details below. We may need to verify your identity before acting on a request.',
      'For information held in the platform by a customer organization, please contact that organization; we will support them in responding as required.',
    ],
  },
  {
    id: 'children',
    title: 'Children’s information',
    body: [
      'Our website is intended for organizations and professionals and is not directed to children. Information about clients who are minors is entered into the platform by customer organizations as part of their services, and is handled as described in the section on customer organization data.',
    ],
  },
  {
    id: 'changes',
    title: 'Changes to this policy',
    body: [
      'We may update this policy from time to time. When we do, we will revise the “Last updated” date at the top of this page. Significant changes may also be communicated through the platform or by email.',
    ],
  },
  {
    id: 'contact',
    title: 'Contact us',
    body: [
      <p key="c">
        For privacy questions or requests, contact {PROVIDER} at <a href={`mailto:${EMAIL}`}>{EMAIL}</a> or through
        our <Link to="/contact">contact page</Link>.
      </p>,
    ],
  },
];

export function PrivacyPolicyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro={`How ${PROVIDER} handles information on the ${PRODUCT} website and platform.`}
      sections={SECTIONS}
    />
  );
}

export default PrivacyPolicyPage;
