import { Icon, PageHead } from './ui.jsx';
import SettingsPage from './SettingsPage.jsx';
import PrivacyWorkspace, { useWorkspaceAccess } from './AuthWorkspace.jsx';
import CustomFieldsWorkspace from './CustomFieldsWorkspace.jsx';
import SystemWorkspace from './SystemWorkspace.jsx';
import ExportPanel from './ExportPanel.jsx';
import CategoryCatalogSettings from './CategoryCatalogSettings.jsx';

export const SETTINGS_VIEWS = ['settings', 'categories', 'fields', 'export', 'privacy', 'system'];
const SECTIONS = [
  ['settings', 'settings', 'Search limits', 'manageWorkspace'],
  ['categories', 'building', 'Business categories', 'read'],
  ['fields', 'list', 'Data & fields', 'read'],
  ['export', 'download', 'Export', 'read'],
  ['privacy', 'lock', 'Workspace access', 'read'],
  ['system', 'activity', 'System checks', 'manageWorkspace'],
];

export default function SettingsWorkspace({ view, onNavigate, meta, notify, scanId, filters, selected, onChanged, onOpenLeads, initialAccessSection, onDirtyChange, onBusyChange, busy }) {
  const access = useWorkspaceAccess();
  const available = SECTIONS.filter(([, , , permission]) => access.permissions.includes(permission));
  const section = available.some(([id]) => id === view) ? view : 'privacy';
  const common = { notify, onDirtyChange, onBusyChange };
  return <div className="page settings-workspace"><PageHead title="Settings" description="Manage your workspace, data, and search preferences in one place."/>
    <nav className="settings-sections" aria-label="Settings sections">{available.map(([id, icon, label]) => <button key={id} className={section === id ? 'on' : ''} aria-current={section === id ? 'page' : undefined} disabled={busy && id !== section} onClick={() => onNavigate(id)}><Icon name={icon} size={16}/>{label}</button>)}</nav>
    <div className="settings-content">
      {section === 'settings' && <SettingsPage {...common}/>}
      {section === 'categories' && <CategoryCatalogSettings {...common} meta={meta}/>}
      {section === 'fields' && <CustomFieldsWorkspace {...common} onChanged={onChanged} onOpenLeads={onOpenLeads} readOnly={!access.permissions.includes('manageSchema')}/>}
      {section === 'export' && <ExportPanel {...common} scanId={scanId} filters={filters} selected={selected} onOpenLeads={onOpenLeads}/>}
      {section === 'privacy' && <PrivacyWorkspace {...common} initialSection={initialAccessSection}/>}
      {section === 'system' && <SystemWorkspace {...common}/>}
    </div>
  </div>;
}
