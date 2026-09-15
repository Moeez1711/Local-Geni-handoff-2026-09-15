import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { AuthBoundary } from './components/AuthWorkspace.jsx';
import { PressFeedback } from './components/FluidMotion.jsx';
import './brand-fonts.css';
import './styles.css';
import './email.css';
import './workspace.css';
import './alignment.css';
import './account.css';
import './lead-drawer.css';
import './leads.css';
import './category-catalog.css';
import './export.css';
import './settings-workspace.css';
import './app-polish.css';
import './search-workspace.css';
import './visual-system.css';
import './fluid-interface.css';
// Keep the established Local Geni visual layer together after the feature
// styles; the product system below is the final semantic override layer.
import './senit-theme.css';
// Final semantic tokens and product-level component states. Keep this last so
// the app has one deliberate visual contract even while older feature styles
// remain split across their workspaces.
import './design-system.css';

createRoot(document.getElementById('root')).render(<StrictMode><PressFeedback/><AuthBoundary><App /></AuthBoundary></StrictMode>);
