import { Link, useNavigate, useParams } from 'react-router-dom';
import { useToast } from '@/components';
import { Icon } from '@/ui';
import { AppointmentEditor } from './redesign/AppointmentEditor.jsx';

/**
 * /scheduling/appointments/:appointmentId/edit — Reschedule Appointment.
 *
 * The same editor the Scheduling page opens in a drawer, on the existing
 * versioned PATCH /v1/scheduling/appointments/:id. Dates and times are in the
 * organization timezone; a date-only appointment stays date-only. (Creating an
 * appointment happens only from Scheduling → Book Appointment; /new redirects there.)
 */
export function AppointmentFormPage() {
  const { appointmentId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const back = `/scheduling/appointments/${appointmentId}`;
  return (
    <div className="rx-ae-wrap">
      <Link to={back} className="rx-sp__back"><Icon.Return size={15} /> Back to appointment</Link>
      <header className="rx-ae-wrap__head">
        <h1 className="rx-ae-wrap__title">Reschedule Appointment</h1>
        <p className="rx-ae-wrap__subtitle">Change the date, time, units or notes. The client, clinician and authorizations stay the same.</p>
      </header>
      <AppointmentEditor appointmentId={appointmentId} variant="page"
        onCancel={() => navigate(back)}
        onSaved={(_updated, message) => { toast.push(message); navigate(back); }} />
    </div>
  );
}

export default AppointmentFormPage;
