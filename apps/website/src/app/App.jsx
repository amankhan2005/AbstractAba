import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { routes } from './routes.jsx';

const router = createBrowserRouter(routes);

/** The public website root. No authentication, session or tenant state here. */
export function App() {
  return <RouterProvider router={router} />;
}
