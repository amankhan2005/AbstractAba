import { Icon } from '../icons.jsx';

/** A search + filter row that sits above a table. Children are filter controls. */
export function Toolbar({ search, onSearch, placeholder = 'Search…', children }) {
  return (
    <div className="rx-toolbar">
      {onSearch !== undefined && (
        <div className="rx-toolbar__search">
          <Icon.Search size={16} />
          <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder={placeholder} />
        </div>
      )}
      <div className="rx-toolbar__filters">{children}</div>
    </div>
  );
}
