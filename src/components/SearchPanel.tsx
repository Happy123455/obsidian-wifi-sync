import React, { useState, useEffect, useRef, useCallback } from 'react';

interface SearchResult {
  relPath: string;
  fullPath: string;
  mtime: number;
  size: number;
  snippet: string;
}

interface SearchPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SearchPanel: React.FC<SearchPanelProps> = ({ isOpen, onClose }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(new Date().getMonth());
  const [calendarYear, setCalendarYear] = useState(new Date().getFullYear());
  const [fileDates, setFileDates] = useState<Record<string, number>>({});
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
    if (!isOpen) {
      // Reset state when closing
      setQuery('');
      setResults([]);
      setSelectedDate(null);
    }
  }, [isOpen]);

  // Load calendar dots when month changes
  useEffect(() => {
    if (!isOpen) return;
    window.api.getFileCalendar(calendarYear, calendarMonth).then(setFileDates);
  }, [isOpen, calendarYear, calendarMonth]);

  // Debounced search
  const performSearch = useCallback((q: string, date: string | null) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (!q && !date) {
        setResults([]);
        return;
      }
      setIsSearching(true);
      try {
        const res = await window.api.searchFiles(q, date);
        setResults(res);
      } catch (err) {
        console.error('Search error:', err);
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);
  }, []);

  // Trigger search when query or date changes
  useEffect(() => {
    performSearch(query, selectedDate);
  }, [query, selectedDate, performSearch]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleDateClick = (dateStr: string) => {
    if (selectedDate === dateStr) {
      setSelectedDate(null); // Toggle off
    } else {
      setSelectedDate(dateStr);
    }
  };

  const handleResultClick = (fullPath: string) => {
    window.api.openFile(fullPath);
  };

  // Calendar rendering helpers
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  const getDaysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate();
  const getFirstDayOfMonth = (year: number, month: number) => new Date(year, month, 1).getDay();

  const renderCalendar = () => {
    const daysInMonth = getDaysInMonth(calendarYear, calendarMonth);
    const firstDay = getFirstDayOfMonth(calendarYear, calendarMonth);
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const cells: React.ReactNode[] = [];

    // Empty cells for days before the first
    for (let i = 0; i < firstDay; i++) {
      cells.push(<div key={`empty-${i}`} className="calendar-day empty" />);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const hasFiles = (fileDates[dateStr] || 0) > 0;
      const isToday = dateStr === todayStr;
      const isSelected = dateStr === selectedDate;

      cells.push(
        <div
          key={day}
          className={`calendar-day ${hasFiles ? 'has-files' : ''} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}`}
          onClick={() => handleDateClick(dateStr)}
          title={hasFiles ? `${fileDates[dateStr]} file(s)` : ''}
        >
          <span>{day}</span>
          {hasFiles && <span className="calendar-dot-indicator" />}
        </div>
      );
    }

    return cells;
  };

  const prevMonth = () => {
    if (calendarMonth === 0) {
      setCalendarMonth(11);
      setCalendarYear(y => y - 1);
    } else {
      setCalendarMonth(m => m - 1);
    }
  };

  const nextMonth = () => {
    if (calendarMonth === 11) {
      setCalendarMonth(0);
      setCalendarYear(y => y + 1);
    } else {
      setCalendarMonth(m => m + 1);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (timestamp: number) => {
    const d = new Date(timestamp * 1000);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  // Highlight matching query text in snippet
  const highlightSnippet = (snippet: string, q: string) => {
    if (!q || !snippet) return snippet;
    const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = snippet.split(regex);
    return parts.map((part, i) =>
      regex.test(part) ? <mark key={i} className="search-highlight">{part}</mark> : part
    );
  };

  // Get file extension icon
  const getFileIcon = (relPath: string) => {
    const ext = relPath.split('.').pop()?.toLowerCase() || '';
    if (['md'].includes(ext)) return '📝';
    if (['canvas'].includes(ext)) return '🎨';
    if (['txt'].includes(ext)) return '📄';
    if (['json'].includes(ext)) return '⚙️';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return '🖼️';
    if (['pdf'].includes(ext)) return '📕';
    return '📎';
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="search-panel-overlay" onClick={onClose} />
      <div className={`search-panel ${isOpen ? 'open' : ''}`}>
        <div className="search-panel-header">
          <div className="search-panel-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <span>Search Vault</span>
          </div>
          <button className="search-panel-close" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="search-panel-body">
          {/* Calendar Section */}
          <div className="search-calendar-section">
            <div className="calendar-nav">
              <button className="calendar-nav-btn" onClick={prevMonth}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <span className="calendar-month-label">{monthNames[calendarMonth]} {calendarYear}</span>
              <button className="calendar-nav-btn" onClick={nextMonth}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            </div>
            <div className="calendar-grid">
              {dayNames.map(d => <div key={d} className="calendar-day-header">{d}</div>)}
              {renderCalendar()}
            </div>
            {selectedDate && (
              <div className="calendar-filter-badge">
                <span>Filtering: {selectedDate}</span>
                <button onClick={() => setSelectedDate(null)}>✕</button>
              </div>
            )}
          </div>

          {/* Search Input */}
          <div className="search-input-wrap">
            <svg className="search-input-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              ref={inputRef}
              type="text"
              className="search-input"
              placeholder="Search notes, files, and content..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="search-clear-btn" onClick={() => setQuery('')}>✕</button>
            )}
          </div>

          {/* Results */}
          <div className="search-results">
            {isSearching && (
              <div className="search-status">
                <div className="search-spinner" />
                <span>Searching...</span>
              </div>
            )}

            {!isSearching && results.length === 0 && (query || selectedDate) && (
              <div className="search-empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"/>
                  <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  <line x1="8" y1="11" x2="14" y2="11"/>
                </svg>
                <span>No results found</span>
                <span className="search-empty-hint">
                  {selectedDate ? 'Try a different date or clear the filter' : 'Try a different search term'}
                </span>
              </div>
            )}

            {!isSearching && !query && !selectedDate && (
              <div className="search-empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"/>
                  <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <span>Search your vault</span>
                <span className="search-empty-hint">Type to search or click a date on the calendar</span>
              </div>
            )}

            {!isSearching && results.length > 0 && (
              <>
                <div className="search-result-count">
                  {results.length} result{results.length !== 1 ? 's' : ''}
                  {selectedDate ? ` on ${selectedDate}` : ''}
                </div>
                {results.map((result, i) => (
                  <div
                    key={i}
                    className="search-result-item"
                    onClick={() => handleResultClick(result.fullPath)}
                    title={`Open ${result.relPath}`}
                  >
                    <div className="result-header">
                      <span className="result-icon">{getFileIcon(result.relPath)}</span>
                      <span className="result-filename">{result.relPath.split('/').pop()}</span>
                    </div>
                    <div className="result-path">{result.relPath}</div>
                    {result.snippet && (
                      <div className="result-snippet">
                        {highlightSnippet(result.snippet, query)}
                      </div>
                    )}
                    <div className="result-meta">
                      <span>{formatDate(result.mtime)}</span>
                      <span>{formatFileSize(result.size)}</span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
};
