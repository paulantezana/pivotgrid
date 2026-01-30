/**
 * ==========================================
 * 1. FAKE SERVER
 * ==========================================
 */
class FakeServer {
  constructor(rawData) {
    this.rawData = rawData;
  }

  updateRowData(id, field, newValue) {
    const row = this.rawData.find(r => r.id == id);
    if (row) {
      row[field] = newValue;
      console.log(`💾 Server Saved: ID ${id}, Field ${field} = ${newValue}`);
      return true;
    }
    return false;
  }

  async getData(request) {
    await new Promise(r => setTimeout(r, 100));
    let resultData = [...this.rawData];

    // 1. FILTER
    if (request.filterModel && Object.keys(request.filterModel).length > 0) {
      resultData = resultData.filter(row => {
        return Object.entries(request.filterModel).every(([field, filter]) => {
          if (!filter || filter.value === '') return true;
          const value = String(row[field] || '').toLowerCase();
          const filterVal = String(filter.value).toLowerCase();
          return value.includes(filterVal);
        });
      });
    }

    // 2. DRILL-DOWN
    if (request.groupKeys && request.groupKeys.length > 0) {
      request.groupKeys.forEach((key, index) => {
        const groupField = request.rowGroupCols[index].field;
        resultData = resultData.filter(row => String(row[groupField]) === String(key));
      });
    }

    // 3. PIVOT COLUMNS
    let dynamicPivotColumns = [];
    if (request.isPivotMode && request.pivotCols.length > 0) {
      const pivotField = request.pivotCols[0].field;
      const uniqueVals = [...new Set(resultData.map(r => r[pivotField]))].sort();
      uniqueVals.forEach(val => {
        request.valueCols.forEach(vCol => {
          dynamicPivotColumns.push({
            headerName: `${val} - ${vCol.headerName}`,
            field: `${val}_${vCol.field}`,
            width: 110,
            type: 'numeric'
          });
        });
      });
    }

    // 4. GROUPING
    let rows = [];
    const isGrouping = request.isPivotMode && request.rowGroupCols.length > request.groupKeys.length;

    if (isGrouping) {
      const currentLevel = request.groupKeys.length;
      const groupCol = request.rowGroupCols[currentLevel];
      const isLastLevel = currentLevel === request.rowGroupCols.length - 1;

      const groups = {};
      resultData.forEach(row => {
        const key = row[groupCol.field];
        if (!groups[key]) groups[key] = [];
        groups[key].push(row);
      });

      rows = Object.keys(groups).map(key => {
        const children = groups[key];
        const groupNode = {
          _isGroup: true,
          _groupField: groupCol.field,
          _key: key,
          _level: currentLevel,
          _expanded: false,
          _parentKeys: [...request.groupKeys, key],
          _isLeafGroup: isLastLevel,
          id: `group-${currentLevel}-${key}` // Unique ID for selection
        };

        if (request.pivotCols.length > 0) {
          const pivotField = request.pivotCols[0].field;
          const pivotBuckets = {};
          children.forEach(child => {
            const pVal = child[pivotField];
            if (!pivotBuckets[pVal]) pivotBuckets[pVal] = [];
            pivotBuckets[pVal].push(child);
          });
          Object.keys(pivotBuckets).forEach(pVal => {
            request.valueCols.forEach(vCol => {
              const fieldName = `${pVal}_${vCol.field}`;
              groupNode[fieldName] = this.aggregate(pivotBuckets[pVal], vCol.field, vCol.aggFunc);
            });
          });
        } else {
          request.valueCols.forEach(vc => {
            groupNode[vc.field] = this.aggregate(children, vc.field, vc.aggFunc);
          });
        }
        return groupNode;
      });
    } else {
      if (!request.isPivotMode) rows = resultData;
    }

    // 5. SORT
    if (request.sortModel && request.sortModel.length > 0) {
      const { colId, sort } = request.sortModel[0];
      rows.sort((a, b) => {
        let valA = a._isGroup ? a._key : a[colId];
        let valB = b._isGroup ? b._key : b[colId];
        if (a[colId] !== undefined) valA = a[colId];
        if (b[colId] !== undefined) valB = b[colId];
        if (valA === valB) return 0;
        return sort === 'asc' ? (valA > valB ? 1 : -1) : (valA > valB ? -1 : 1);
      });
    }

    // 6. PAGE
    if (request.endRow > 0 && rows.length > request.endRow - request.startRow) {
      rows = rows.slice(request.startRow, request.endRow);
    }

    return { rows, totalCount: rows.length, dynamicPivotColumns };
  }

  aggregate(data, field, func) {
    if (!data || !data.length) return 0;
    const vals = data.map(d => parseFloat(d[field]) || 0);
    let res = 0;
    switch (func) {
      case 'sum': res = vals.reduce((a, b) => a + b, 0); break;
      case 'min': res = Math.min(...vals); break;
      case 'max': res = Math.max(...vals); break;
      case 'avg': res = vals.reduce((a, b) => a + b, 0) / vals.length; break;
      case 'count': res = vals.length; break;
    }
    return parseFloat(res.toFixed(2));
  }
}

/**
 * ==========================================
 * 2. RENDERER & UI
 * ==========================================
 */
class GridRenderer {
  constructor(container, events) {
    this.container = container;
    this.events = events;
    this.renderSkeleton();

    // Popup elements now scoped inside the grid container
    this.columnMenu = this.container.querySelector('#columnMenu');
    this.columnChooser = this.container.querySelector('#columnChooser');

    // References
    this.headerRow = this.container.querySelector('#headerRow');
    this.rowContainer = this.container.querySelector('#rowContainer');
    this.headerContainer = this.container.querySelector('#headerContainer');
    this.bodyViewport = this.container.querySelector('#bodyViewport');
    this.loader = this.container.querySelector('#gridLoader');
    this.toolPanel = this.container.querySelector('#toolPanel');
    this.topPanel = this.container.querySelector('#topPanel');

    this.bindEvents();
  }

  renderSkeleton() {
    this.container.innerHTML = `
                    <div class="ag-theme-custom">
                        <!-- TOP PANEL: Group & Pivot (HIDDEN BY DEFAULT) -->
                        <div class="grid-top-panel hidden" id="topPanel">
                            <div class="top-zone-row">
                                <span class="zone-label"><i class="fas fa-layer-group"></i> Group By</span>
                                <div class="drop-zone-horizontal" id="dz-rowGroup-top" data-zone="rowGroup"></div>
                            </div>
                            <div class="top-zone-row hidden" id="pivotZoneContainer">
                                <span class="zone-label"><i class="fas fa-columns"></i> Pivot By</span>
                                <div class="drop-zone-horizontal" id="dz-pivotCols-top" data-zone="pivotCols"></div>
                            </div>
                        </div>

                        <div class="flex flex-1 overflow-hidden">
                            <!-- Left: Grid Area -->
                            <div class="flex-1 flex flex-col overflow-hidden relative">
                                <div class="grid-header-container" id="headerContainer">
                                    <div class="grid-header-row" id="headerRow"></div>
                                </div>
                                <div class="grid-body-viewport" id="bodyViewport">
                                    <div class="grid-row-container" id="rowContainer"></div>
                                    <div id="gridLoader" class="loading-overlay hidden">
                                        <i class="fas fa-circle-notch fa-spin mr-2"></i> Procesando...
                                    </div>
                                </div>
                                <div class="bg-gray-50 border-t p-2 text-xs flex justify-between" id="statusBar">
                                    <span id="statusTotal">0 items</span>
                                    <span>V11 Enterprise</span>
                                </div>
                            </div>
                            <!-- Right: Tool Panel (HIDDEN BY DEFAULT) -->
                            <div class="tool-panel hidden" id="toolPanel">
                                <div class="tool-panel-header">
                                    <span class="font-bold text-xs uppercase text-gray-500">Settings</span>
                                    <div class="flex items-center gap-2">
                                        <span class="text-[10px] font-bold text-gray-600 uppercase">Pivot Mode</span>
                                        <label class="relative inline-flex items-center cursor-pointer">
                                            <input type="checkbox" id="pivotModeToggle" class="sr-only peer">
                                            <div class="w-7 h-4 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-blue-600"></div>
                                        </label>
                                    </div>
                                </div>

                                <div class="side-tabs">
                                    <div class="side-tab active" data-tab="columns">Columns</div>
                                    <div class="side-tab" data-tab="filters">Filters</div>
                                </div>
                                <div class="tab-content active" id="tab-columns">
                                    <div class="mb-4">
                                        <div class="text-[10px] font-bold uppercase text-gray-500 mb-2">All Columns (Drag to Top)</div>
                                        <div id="colVisList" class="flex flex-col max-h-60 overflow-y-auto p-1 border rounded bg-gray-50"></div>
                                    </div>
                                    <div class="text-[10px] font-bold uppercase text-green-600 mt-2 mb-1">Values</div>
                                    <div class="drop-zone bg-green-50/50 border-green-200" id="dz-value" data-zone="value"></div>
                                </div>
                                <div class="tab-content" id="tab-filters">
                                    <div class="text-xs text-gray-400 italic mb-2">Server-side filters</div>
                                    <div id="filterListContainer" class="flex flex-col gap-2"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div id="columnMenu" class="popup-menu"></div>
                    <div id="columnChooser" class="column-chooser-modal hidden">
                      <div class="chooser-header">
                        <span>Choose Columns</span>
                        <button id="closeChooserBtn" class="text-gray-400 hover:text-red-500"><i class="fas fa-times"></i></button>
                      </div>
                      <div class="chooser-body" id="chooserList"></div>
                    </div>
                `;
  }

  bindEvents() {
    this.bodyViewport.addEventListener('scroll', () => {
      this.headerContainer.scrollLeft = this.bodyViewport.scrollLeft;
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu-btn') && !e.target.closest('.popup-menu')) {
        this.columnMenu.classList.remove('active');
      }
    });

    // Close Modal Event (scoped)
    const closeBtn = this.container.querySelector('#closeChooserBtn');
    if (closeBtn) closeBtn.onclick = () => this.columnChooser.classList.add('hidden');

    document.addEventListener('mousemove', (e) => this.events.onResizeMove(e));
    document.addEventListener('mouseup', () => this.events.onResizeEnd());

    this.container.querySelectorAll('.side-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.container.querySelectorAll('.side-tab').forEach(t => t.classList.remove('active'));
        this.container.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        this.container.querySelector(`#tab-${tab.dataset.tab}`).classList.add('active');
      });
    });
    this.setupDragAndDrop();
  }

  setLoading(visible) {
    visible ? this.loader.classList.remove('hidden') : this.loader.classList.add('hidden');
  }
  toggleSidePanel(forceState) {
    if (typeof forceState === 'boolean') {
      forceState ? this.toolPanel.classList.remove('hidden') : this.toolPanel.classList.add('hidden');
    } else {
      this.toolPanel.classList.toggle('hidden');
    }
  }

  updateTopPanelVisibility(isPivotMode) {
    // If Pivot Mode is ON, show top panel. If OFF, hide it.
    const pivotZone = this.container.querySelector('#pivotZoneContainer');
    if (isPivotMode) {
      this.topPanel.classList.remove('hidden');
      if (pivotZone) pivotZone.classList.remove('hidden');
    } else {
      this.topPanel.classList.add('hidden');
      if (pivotZone) pivotZone.classList.add('hidden');
    }
  }

  renderColumnChooser(colDefs) {
    const list = this.container.querySelector('#chooserList');
    if (!list) return;
    list.innerHTML = '';

    colDefs.forEach((col, index) => {
      if (col.field.startsWith('_')) return; // Skip internal cols

      const item = document.createElement('div');
      item.className = 'chooser-item';
      item.draggable = true;
      item.dataset.index = index;

      item.innerHTML = `
                        <i class="fas fa-grip-lines text-gray-400"></i>
                        <input type="checkbox" ${!col.hide ? 'checked' : ''} class="cursor-pointer">
                        <span class="text-xs font-medium text-gray-700">${col.headerName}</span>
                    `;

      // Visibility Toggle
      item.querySelector('input').onchange = (e) => this.events.onColVisibility(col.field, e.target.checked);

      // Reorder Logic (Simple Drag & Drop Reorder)
      item.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', index);
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => item.classList.remove('dragging'));
      item.addEventListener('dragover', e => e.preventDefault());
      item.addEventListener('drop', e => {
        e.preventDefault();
        const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
        const toIndex = index;
        this.events.onColReorder(fromIndex, toIndex);
      });

      list.appendChild(item);
    });

    this.columnChooser.classList.remove('hidden');
  }

  /**
   * RENDER HEADERS
   */
  renderHeaders(cols, sortModel, filterModel, isPivotMode, selectionConfig, isAllSelected) {
    this.headerRow.innerHTML = '';

    let leftOffset = 0;
    let rightOffset = 0;
    const rightPinnedCols = cols.filter(c => c.pinned === 'right');
    rightPinnedCols.reverse().forEach(col => {
      col._right = rightOffset;
      rightOffset += (col.width || 150);
    });

    cols.forEach((col, index) => {
      if (col.hide) return;

      const width = col.width || 150;
      const cell = document.createElement('div');
      cell.className = 'grid-header-cell';
      cell.style.width = `${width}px`;
      cell.style.minWidth = `${width}px`;
      cell.dataset.field = col.field;

      // PINNING LOGIC
      if (col.pinned === 'left') {
        cell.classList.add('header-pinned', 'cell-pinned');
        cell.style.left = `${leftOffset}px`;
        const nextCol = cols[index + 1];
        if (!nextCol || nextCol.pinned !== 'left') cell.classList.add('cell-pinned-left-last');
        leftOffset += width;
      } else if (col.pinned === 'right') {
        cell.classList.add('header-pinned', 'cell-pinned');
        cell.style.right = `${col._right}px`;
        const prevCol = cols[index - 1];
        if (!prevCol || prevCol.pinned !== 'right') cell.classList.add('cell-pinned-right-first');
      }

      // --- SELECTION HEADER (Revised V10) ---
      if (col.field === '_selection') {
        // Custom container for selection header to include menu
        const top = document.createElement('div');
        top.className = 'header-top group w-full h-full flex items-center justify-between px-1';

        // Left side: Checkbox (if multiple)
        const leftDiv = document.createElement('div');
        if (selectionConfig === 'multiple') {
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'grid-selection-input';
          checkbox.checked = isAllSelected;
          checkbox.onclick = (e) => this.events.onSelectAll(e.target.checked);
          leftDiv.appendChild(checkbox);
        } else {
          leftDiv.innerHTML = '&nbsp;';
        }

        // Right side: Menu Button
        const menuDiv = document.createElement('div');
        menuDiv.className = 'header-icons';
        const btn = document.createElement('div');
        btn.className = 'menu-btn ml-1';
        btn.innerHTML = '<i class="fas fa-bars"></i>';
        btn.onclick = (e) => this.showColumnMenu(e, col);
        menuDiv.appendChild(btn);

        top.appendChild(leftDiv);
        top.appendChild(menuDiv);
        cell.appendChild(top);
      }
      // --- NORMAL COLUMNS ---
      else {
        const sortState = sortModel.find(s => s.colId === col.field);
        const sortIcon = sortState
          ? (sortState.sort === 'asc' ? 'fa-arrow-up icon-active' : 'fa-arrow-down icon-active')
          : 'fa-sort icon-inactive opacity-0 group-hover:opacity-50';
        const isFiltered = filterModel[col.field] && filterModel[col.field].value;
        const filterIcon = isFiltered ? 'fa-filter icon-active' : 'fa-filter icon-inactive opacity-20';

        const top = document.createElement('div');
        top.className = 'header-top group';
        top.innerHTML = `
                            <span class="header-label">${col.headerName}</span>
                            <div class="header-icons">
                                <i class="fas ${filterIcon}"></i>
                                <i class="fas ${sortIcon}"></i>
                                <div class="menu-btn"><i class="fas fa-bars"></i></div>
                            </div>
                        `;

        top.querySelector('.header-label').onclick = () => this.events.onSort(col.field);
        top.querySelector('.menu-btn').onclick = (e) => this.showColumnMenu(e, col);

        cell.appendChild(top);

        if (!isPivotMode && !col.field.startsWith('_')) {
          const input = document.createElement('input');
          input.className = 'grid-cell-input mt-1';
          input.placeholder = 'Filter...';
          if (filterModel[col.field]) input.value = filterModel[col.field].value;
          input.oninput = (e) => this.events.onFilterChange(col.field, e.target.value);
          input.onclick = (e) => e.stopPropagation();
          cell.appendChild(input);
        }

        const handle = document.createElement('div');
        handle.className = 'resize-handle';
        handle.onmousedown = (e) => this.events.onResizeStart(e, col.field);
        cell.appendChild(handle);
      }

      this.headerRow.appendChild(cell);
    });
  }

  showColumnMenu(e, col) {
    e.stopPropagation();
    const rect = e.target.getBoundingClientRect();
    this.columnMenu.style.top = `${rect.bottom + 5}px`;
    this.columnMenu.style.left = `${rect.right - 160}px`;
    this.columnMenu.classList.add('active');

    this.columnMenu.innerHTML = `
                    <div class="menu-item" data-action="sortAsc"><i class="fas fa-arrow-up w-4 text-gray-400"></i> Sort Ascending</div>
                    <div class="menu-item" data-action="sortDesc"><i class="fas fa-arrow-down w-4 text-gray-400"></i> Sort Descending</div>
                    <div class="menu-separator"></div>
                    <div class="menu-item" data-action="pinLeft"><i class="fas fa-thumbtack transform -rotate-45 w-4 text-gray-400"></i> Pin Left</div>
                    <div class="menu-item" data-action="pinRight"><i class="fas fa-thumbtack transform rotate-45 w-4 text-gray-400"></i> Pin Right</div>
                    <div class="menu-item" data-action="noPin"><i class="fas fa-ban w-4 text-gray-400"></i> No Pin</div>
                    <div class="menu-separator"></div>
                    <div class="menu-item" data-action="autosize"><i class="fas fa-arrows-alt-h w-4 text-gray-400"></i> Autosize This Column</div>
                    <div class="menu-separator"></div>
                    <div class="menu-item" data-action="hideCol"><i class="fas fa-eye-slash w-4 text-gray-400"></i> Hide Column</div>
                    <div class="menu-item" data-action="chooseCols"><i class="fas fa-list w-4 text-gray-400"></i> Choose Columns...</div>
                    <div class="menu-separator"></div>
                    <div class="menu-item" data-action="showSidePanel"><i class="fas fa-columns w-4 text-gray-400"></i> Show Side Panel</div>
                `;

    this.columnMenu.querySelectorAll('.menu-item').forEach(item => {
      item.onclick = () => {
        this.events.onMenuAction(col.field, item.dataset.action);
        this.columnMenu.classList.remove('active');
      };
    });
  }

  renderRows(rows, cols, isPivotMode, selectedIds, selectionConfig) {
    this.rowContainer.innerHTML = '';
    if (rows.length === 0) {
      this.rowContainer.innerHTML = '<div class="p-4 italic text-gray-400">No rows to show</div>';
      return;
    }

    let leftOffset = 0;
    let rightOffset = 0;
    const rightPinnedCols = cols.filter(c => c.pinned === 'right');
    rightPinnedCols.reverse().forEach(col => {
      col._right = rightOffset;
      rightOffset += (col.width || 150);
    });

    const fragment = document.createDocumentFragment();

    rows.forEach((row, rowIndex) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'grid-row';
      if (row._isGroup) rowEl.classList.add('group-row');

      const isSelected = selectedIds.has(row.id);

      // SELECTION STATE (Visual)
      if (isSelected) {
        rowEl.classList.add('selected');
      }

      // Standard click event (for row clicking behavior if configured)
      rowEl.addEventListener('click', (e) => {
        // If clicking specifically on the checkbox/radio, don't trigger row click again
        if (e.target.classList.contains('grid-selection-input')) return;
        this.events.onRowClick(row, e, rowIndex);
      });

      leftOffset = 0;

      cols.forEach((col, index) => {
        if (col.hide) return;
        const width = col.width || 150;
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        cell.style.width = `${width}px`;
        cell.style.minWidth = `${width}px`;

        // Pinning
        if (col.pinned === 'left') {
          cell.classList.add('cell-pinned');
          cell.style.left = `${leftOffset}px`;
          const nextCol = cols[index + 1];
          if (!nextCol || nextCol.pinned !== 'left') cell.classList.add('cell-pinned-left-last');
          leftOffset += width;
        } else if (col.pinned === 'right') {
          cell.classList.add('cell-pinned');
          cell.style.right = `${col._right}px`;
          const prevCol = cols[index - 1];
          if (!prevCol || prevCol.pinned !== 'right') cell.classList.add('cell-pinned-right-first');
        }

        // --- SELECTION CELL ---
        if (col.field === '_selection') {
          cell.classList.add('justify-center');
          const input = document.createElement('input');
          input.className = 'grid-selection-input';
          input.type = selectionConfig === 'multiple' ? 'checkbox' : 'radio';
          input.name = 'grid-row-select'; // Required for radio grouping (visually)
          input.checked = isSelected;

          // Input Click Event
          input.onclick = (e) => {
            e.stopPropagation(); // Stop row click
            this.events.onRowSelect(row, e.target.checked, rowIndex, selectionConfig);
          };
          cell.appendChild(input);
        }
        // --- GROUP COLUMN ---
        else if (col.field === '_group') {
          if (row._isGroup) {
            const padding = row._level * 20;
            cell.style.paddingLeft = `${padding + 8}px`;
            if (!row._isLeafGroup) {
              const icon = row._expanded ? 'fa-chevron-down' : 'fa-chevron-right';
              cell.innerHTML = `<i class="fas ${icon} text-[10px] w-4 cursor-pointer mr-1 hover:text-blue-600 toggle-icon"></i><span>${row._key}</span>`;
              cell.querySelector('.toggle-icon').onclick = (e) => {
                e.stopPropagation();
                this.events.onGroupToggle(row);
              };
            } else {
              cell.innerHTML = `<span class="ml-5 text-gray-600">${row._key}</span>`;
            }
          }
        }
        // --- NORMAL COLUMN ---
        else {
          const val = row[col.field];

          // Custom Renderer
          if (col.cellRenderer) {
            const params = { value: val, data: row, colDef: col };
            const rendered = col.cellRenderer(params);
            if (rendered instanceof HTMLElement) {
              cell.appendChild(rendered);
            } else {
              cell.innerHTML = rendered;
            }
          } else {
            cell.innerText = (val !== undefined && val !== null) ? val : '';
          }

          if (typeof val === 'number') cell.classList.add('justify-end');

          // Editing
          if (!isPivotMode && !row._isGroup) {
            const isEditable = typeof col.editable === 'function' ? col.editable(row) : col.editable;
            if (isEditable) {
              cell.classList.add('editable-cell');
              cell.title = "Double click to edit";
              cell.addEventListener('dblclick', (e) => {
                this.startEditing(cell, row, col);
              });
            }
          }
        }
        rowEl.appendChild(cell);
      });
      fragment.appendChild(rowEl);
    });

    this.rowContainer.appendChild(fragment);
    const status = this.container.querySelector('#statusTotal');
    if (status) status.innerText = `${rows.length} rows loaded`;
  }

  startEditing(cell, row, col) {
    if (cell.classList.contains('editing')) return;

    cell.classList.add('editing');
    const currentValue = row[col.field];

    const input = document.createElement('input');
    input.className = 'cell-editor';
    input.value = currentValue !== undefined ? currentValue : '';

    cell.innerHTML = '';
    cell.appendChild(input);
    input.focus();

    const stopEdit = (save) => {
      if (!cell.classList.contains('editing')) return;

      const newValue = input.value;
      cell.innerHTML = '';
      cell.classList.remove('editing');

      if (save && newValue != currentValue) {
        this.events.onCellValueChanged(row.id, col.field, newValue);
        cell.innerText = newValue;
      } else {
        this.events.onRefreshReq();
      }
    };

    input.addEventListener('blur', () => stopEdit(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        stopEdit(true);
      } else if (e.key === 'Escape') {
        stopEdit(false);
      }
    });
  }

  renderToolPanel(allCols, state) {
    // 1. Column List (Drag Source)
    const visList = this.container.querySelector('#colVisList');
    if (visList) visList.innerHTML = '';
    allCols.forEach(col => {
      if (col.field.startsWith('_')) return;
      const item = document.createElement('div');
      item.className = 'col-vis-item';
      item.draggable = true;
      item.innerHTML = `
                        <i class="fas fa-grip-vertical drag-handle"></i>
                        <input type="checkbox" ${!col.hide ? 'checked' : ''} class="cursor-pointer">
                        <span class="flex-1">${col.headerName}</span>
                    `;
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('json', JSON.stringify({ field: col.field, from: 'list' }));
        item.classList.add('opacity-50');
      });
      item.addEventListener('dragend', () => item.classList.remove('opacity-50'));
      item.querySelector('input').onchange = (e) => this.events.onColVisibility(col.field, e.target.checked);
      if (visList) visList.appendChild(item);
    });

    // 2. Drop Zones (Now Split between Top and Side)
    const zones = {
      rowGroup: this.container.querySelector('#dz-rowGroup-top'), // En Panel Superior
      pivotCols: this.container.querySelector('#dz-pivotCols-top'), // En Panel Superior
      value: this.container.querySelector('#dz-value') // En Panel Lateral
    };

    Object.values(zones).forEach(z => {
      if (z) z.innerHTML = '';
    });

    const createChip = (col, zone) => {
      const el = document.createElement('div');
      el.className = 'draggable-chip'; el.draggable = true;
      el.innerHTML = `<span>${col.headerName}</span>`;

      if (zone === 'value') {
        el.innerHTML += `<select class="ml-2 text-[9px] font-bold text-blue-600 border-none bg-transparent cursor-pointer" onmousedown="event.stopPropagation()">
                            <option value="sum" ${col.aggFunc == 'sum' ? 'selected' : ''}>SUM</option>
                            <option value="max" ${col.aggFunc == 'max' ? 'selected' : ''}>MAX</option>
                            <option value="count" ${col.aggFunc == 'count' ? 'selected' : ''}>CNT</option>
                        </select>`;
        el.querySelector('select').onchange = (e) => this.events.onAggChange(col.field, e.target.value);
      }

      const removeBtn = document.createElement('i');
      removeBtn.className = 'fas fa-times ml-2 cursor-pointer text-gray-400 hover:text-red-500';
      removeBtn.onclick = () => this.events.onRemoveFromZone(col.field, zone);
      el.appendChild(removeBtn);

      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('json', JSON.stringify({ field: col.field, from: zone })); });
      return el;
    };

    if (zones.rowGroup) state.rowGroupCols.forEach(c => zones.rowGroup.appendChild(createChip(c, 'rowGroup')));
    if (zones.pivotCols) state.pivotCols.forEach(c => zones.pivotCols.appendChild(createChip(c, 'pivotCols')));
    if (zones.value) state.valueCols.forEach(c => zones.value.appendChild(createChip(c, 'value')));

    // 3. Filters
    const filterContainer = this.container.querySelector('#filterListContainer');
    if (filterContainer) filterContainer.innerHTML = '';
    allCols.forEach(col => {
      if (col.field.startsWith('_')) return;
      const item = document.createElement('div');
      item.className = 'filter-panel-item';
      const val = state.filterModel[col.field] ? state.filterModel[col.field].value : '';
      item.innerHTML = `<label class="filter-label">${col.headerName}</label><input type="text" class="grid-cell-input bg-gray-50" placeholder="Filter..." value="${val}">`;
      item.querySelector('input').oninput = (e) => this.events.onFilterChange(col.field, e.target.value);
      if (filterContainer) filterContainer.appendChild(item);
    });
  }

  setupDragAndDrop() {
    this.container.querySelectorAll('.drop-zone, .drop-zone-horizontal').forEach(z => {
      z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('drag-over'); });
      z.addEventListener('dragleave', () => z.classList.remove('drag-over'));
      z.addEventListener('drop', e => {
        e.preventDefault();
        z.classList.remove('drag-over');
        const data = JSON.parse(e.dataTransfer.getData('json'));
        this.events.onDrop(data.field, z.dataset.zone);
      });
    });
  }
}

/**
 * ==========================================
 * 3. CONTROLLER
 * ==========================================
 */
class PivotGrid {
  constructor(container, config) {
    this.config = config;
    this.server = new FakeServer(config.rowData);
    this.debounceTimer = null;
    this.isResizing = false;
    this.resizeColField = null;
    this.resizeStartX = 0;
    this.resizeStartWidth = 0;

    this.state = {
      isPivotMode: false,
      rows: [],
      sortModel: [],
      filterModel: {},
      rowGroupCols: [],
      pivotCols: [],
      valueCols: [],
      colDefs: config.columnDefs.map(c => ({ ...c, hide: false, pinned: null, width: c.width || 150 })),
      currentDisplayCols: [],

      // SELECTION STATE
      rowSelection: config.rowSelection || 'single', // 'single' | 'multiple'
      selectedRowIds: new Set(),
      lastSelectedRowIndex: null
    };

    this.renderer = new GridRenderer(container, {
      onSort: this.handleSort.bind(this),
      onFilterChange: this.handleFilter.bind(this),
      onGroupToggle: this.handleGroupToggle.bind(this),
      onColVisibility: this.handleColVisibility.bind(this),
      onColReorder: this.handleColReorder.bind(this),
      onDrop: this.handleDrop.bind(this),
      onRemoveFromZone: this.handleRemoveFromZone.bind(this),
      onAggChange: this.handleAggChange.bind(this),
      onMenuAction: this.handleMenuAction.bind(this),
      onResizeStart: this.handleResizeStart.bind(this),
      onResizeMove: this.handleResizeMove.bind(this),
      onResizeEnd: this.handleResizeEnd.bind(this),
      onCellValueChanged: this.handleCellValueChanged.bind(this),
      onRefreshReq: () => this.loadData(),
      onRowClick: this.handleRowClick.bind(this),
      // NEW: Select Events
      onRowSelect: this.handleRowSelectInput.bind(this),
      onSelectAll: this.handleSelectAll.bind(this)
    });

    this.init();
  }

  init() {
    const toggle = this.renderer.container.querySelector('#pivotModeToggle');
    if (toggle) {
      toggle.addEventListener('change', e => {
        this.state.isPivotMode = e.target.checked;
        this.handleModeChange();
      });
    }

    // Set initial Top Panel State (Hidden in Normal Mode)
    this.renderer.updateTopPanelVisibility(this.state.isPivotMode);

    this.state.currentDisplayCols = this.getSortedDisplayCols();
    const isAllSelected = this.isAllLoadedRowsSelected();
    this.renderer.renderHeaders(this.state.currentDisplayCols, this.state.sortModel, this.state.filterModel, this.state.isPivotMode, this.state.rowSelection, isAllSelected);
    this.renderer.renderToolPanel(this.state.colDefs, this.state);
    this.loadData();
  }

  handleColReorder(fromIndex, toIndex) {
    // Reorder state.colDefs
    if (fromIndex === toIndex) return;

    const colToMove = this.state.colDefs[fromIndex];
    this.state.colDefs.splice(fromIndex, 1);
    this.state.colDefs.splice(toIndex, 0, colToMove);

    this.refreshFullStructure();
    // Update Modal view
    this.renderer.renderColumnChooser(this.state.colDefs);
  }

  handleRowSelectInput(row, isChecked, rowIndex, config) {
    if (config === 'single') {
      this.state.selectedRowIds.clear();
      if (isChecked) this.state.selectedRowIds.add(row.id);
    } else {
      if (isChecked) this.state.selectedRowIds.add(row.id);
      else this.state.selectedRowIds.delete(row.id);
    }
    this.state.lastSelectedRowIndex = rowIndex;
    this.refreshGridSelection();
  }

  handleSelectAll(isChecked) {
    if (isChecked) {
      // Select all loaded rows
      this.state.rows.forEach(r => this.state.selectedRowIds.add(r.id));
    } else {
      // Deselect all
      this.state.selectedRowIds.clear();
    }
    this.refreshGridSelection();
  }

  handleRowClick(row, event, rowIndex) {
    // If clicked on row (not input), behavior depends on standard UX
    // Normally clicking a row selects it (single) or toggles (multi with ctrl)
    if (!this.state.rowSelection) return;

    const id = row.id;
    const isMulti = this.state.rowSelection === 'multiple';
    const isCtrl = event.ctrlKey || event.metaKey;
    const isShift = event.shiftKey;

    if (isMulti) {
      if (isShift && this.state.lastSelectedRowIndex !== null) {
        const start = Math.min(this.state.lastSelectedRowIndex, rowIndex);
        const end = Math.max(this.state.lastSelectedRowIndex, rowIndex);
        if (!isCtrl) this.state.selectedRowIds.clear();
        for (let i = start; i <= end; i++) {
          this.state.selectedRowIds.add(this.state.rows[i].id);
        }
      } else if (isCtrl) {
        if (this.state.selectedRowIds.has(id)) this.state.selectedRowIds.delete(id);
        else this.state.selectedRowIds.add(id);
        this.state.lastSelectedRowIndex = rowIndex;
      } else {
        // Regular click replaces selection in many grids, but check UX requirements.
        // Implemented: Regular click selects ONLY this row
        this.state.selectedRowIds.clear();
        this.state.selectedRowIds.add(id);
        this.state.lastSelectedRowIndex = rowIndex;
      }
    } else {
      // Single
      this.state.selectedRowIds.clear();
      this.state.selectedRowIds.add(id);
    }

    this.refreshGridSelection();
  }

  refreshGridSelection() {
    // Refresh Headers (for Select All Checkbox state)
    const isAllSelected = this.isAllLoadedRowsSelected();
    this.renderer.renderHeaders(this.state.currentDisplayCols, this.state.sortModel, this.state.filterModel, this.state.isPivotMode, this.state.rowSelection, isAllSelected);
    // Refresh Rows
    this.renderer.renderRows(this.state.rows, this.state.currentDisplayCols, this.state.isPivotMode, this.state.selectedRowIds, this.state.rowSelection);
  }

  isAllLoadedRowsSelected() {
    if (this.state.rows.length === 0) return false;
    return this.state.rows.every(r => this.state.selectedRowIds.has(r.id));
  }

  getSortedDisplayCols(dynamicPivotCols = []) {
    let cols = [];

    // 1. Selection Column (Injected Left Pinned)
    if (this.state.rowSelection) {
      cols.push({
        field: '_selection',
        headerName: '', // Empty or Checkbox will be rendered manually
        width: 50,
        // pinned: 'left', <--- REMOVED DEFAULT PINNING
        // suppressMenu: true <--- REMOVED SUPPRESS MENU
      });
    }

    if (this.state.isPivotMode) {
      cols.push({ field: '_group', headerName: 'Group', width: 250, pinned: 'left' });
      if (dynamicPivotCols.length > 0) cols = [...cols, ...dynamicPivotCols];
      else cols = [...cols, ...this.state.valueCols];
    } else {
      cols = [...cols, ...this.state.colDefs];
    }

    const left = cols.filter(c => c.pinned === 'left');
    const center = cols.filter(c => c.pinned !== 'left' && c.pinned !== 'right');
    const right = cols.filter(c => c.pinned === 'right');

    return [...left, ...center, ...right];
  }

  handleMenuAction(field, action) {
    let col = this.state.colDefs.find(c => c.field === field);
    if (!col) col = this.state.currentDisplayCols.find(c => c.field === field);
    if (!col && action !== 'showSidePanel') return;

    switch (action) {
      case 'pinLeft': col.pinned = 'left'; this.refreshFullStructure(); break;
      case 'pinRight': col.pinned = 'right'; this.refreshFullStructure(); break;
      case 'noPin': col.pinned = null; this.refreshFullStructure(); break;
      case 'autosize': col.width = 200; this.refreshFullStructure(); break;
      case 'sortAsc': this.handleSort(field, 'asc'); break;
      case 'sortDesc': this.handleSort(field, 'desc'); break;
      case 'showSidePanel': this.renderer.toggleSidePanel(true); break;
      case 'hideCol':
        col.hide = true;
        this.refreshFullStructure();
        break;
      case 'chooseCols':
        this.renderer.renderColumnChooser(this.state.colDefs);
        break;
    }
  }

  handleCellValueChanged(id, field, newValue) {
    const success = this.server.updateRowData(id, field, newValue);
    if (success) this.loadData();
  }

  handleResizeStart(e, field) {
    e.preventDefault();
    this.isResizing = true;
    this.resizeColField = field;
    this.resizeStartX = e.clientX;
    const col = this.state.currentDisplayCols.find(c => c.field === field);
    this.resizeStartWidth = col ? (col.width || 150) : 150;
    document.body.style.cursor = 'col-resize';
  }

  handleResizeMove(e) {
    if (!this.isResizing) return;
    const delta = e.clientX - this.resizeStartX;
    const newWidth = Math.max(50, this.resizeStartWidth + delta);
    const col = this.state.currentDisplayCols.find(c => c.field === this.resizeColField);
    if (col) {
      col.width = newWidth;
      const mainCol = this.state.colDefs.find(c => c.field === this.resizeColField);
      if (mainCol) mainCol.width = newWidth;
    }
    const isAllSelected = this.isAllLoadedRowsSelected();
    this.renderer.renderHeaders(this.state.currentDisplayCols, this.state.sortModel, this.state.filterModel, this.state.isPivotMode, this.state.rowSelection, isAllSelected);
    this.renderer.renderRows(this.state.rows, this.state.currentDisplayCols, this.state.isPivotMode, this.state.selectedRowIds, this.state.rowSelection);
  }

  handleResizeEnd() {
    if (this.isResizing) {
      this.isResizing = false;
      document.body.style.cursor = 'default';
      this.resizeColField = null;
    }
  }

  handleSort(field, direction = null) {
    let nextSort = direction;
    if (!nextSort) {
      let current = this.state.sortModel.find(s => s.colId === field);
      nextSort = 'asc';
      if (current) {
        if (current.sort === 'asc') nextSort = 'desc';
        else nextSort = null;
      }
    }
    this.state.sortModel = nextSort ? [{ colId: field, sort: nextSort }] : [];
    this.refreshGridSelection(); // Header update needed
    this.loadData();
  }

  handleFilter(field, value) {
    this.state.filterModel[field] = { value };
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.loadData(), 400);
  }

  handleColVisibility(field, visible) {
    const col = this.state.colDefs.find(c => c.field === field);
    if (col) col.hide = !visible;
    this.refreshFullStructure();
    // Also update modal checkboxes if open
    if (this.renderer.columnChooser && !this.renderer.columnChooser.classList.contains('hidden')) {
      this.renderer.renderColumnChooser(this.state.colDefs);
    }
  }

  handleModeChange() {
    this.renderer.updateTopPanelVisibility(this.state.isPivotMode);
    if (this.state.isPivotMode) {
      this.state.rowGroupCols = [];
      this.state.pivotCols = [];
      this.state.valueCols = [];
    }
    this.state.filterModel = {};
    this.state.rows = [];
    this.state.selectedRowIds.clear();
    this.refreshFullStructure();
  }

  handleDrop(field, zone) {
    const col = this.state.colDefs.find(c => c.field === field);
    if (!col) return;
    this.state.rowGroupCols = this.state.rowGroupCols.filter(c => c.field !== field);
    this.state.pivotCols = this.state.pivotCols.filter(c => c.field !== field);
    this.state.valueCols = this.state.valueCols.filter(c => c.field !== field);
    if (zone === 'rowGroup') this.state.rowGroupCols.push(col);
    if (zone === 'pivotCols') this.state.pivotCols.push(col);
    if (zone === 'value') { col.aggFunc = col.aggFunc || 'sum'; this.state.valueCols.push(col); }
    this.refreshFullStructure();
  }

  handleRemoveFromZone(field, zone) {
    if (zone === 'rowGroup') this.state.rowGroupCols = this.state.rowGroupCols.filter(c => c.field !== field);
    if (zone === 'pivotCols') this.state.pivotCols = this.state.pivotCols.filter(c => c.field !== field);
    if (zone === 'value') this.state.valueCols = this.state.valueCols.filter(c => c.field !== field);
    this.refreshFullStructure();
  }

  handleAggChange(field, val) {
    const col = this.state.valueCols.find(c => c.field === field);
    if (col) col.aggFunc = val;
    this.loadData();
  }

  async handleGroupToggle(groupRow) {
    if (groupRow._expanded) {
      groupRow._expanded = false;
      const idx = this.state.rows.indexOf(groupRow);
      let deleteCount = 0;
      for (let i = idx + 1; i < this.state.rows.length; i++) {
        if (this.state.rows[i]._level > groupRow._level) deleteCount++;
        else break;
      }
      this.state.rows.splice(idx + 1, deleteCount);
      this.renderer.renderRows(this.state.rows, this.state.currentDisplayCols, this.state.isPivotMode, this.state.selectedRowIds, this.state.rowSelection);
    } else {
      groupRow._expanded = true;
      this.renderer.setLoading(true);
      const request = this.buildRequest({ groupKeys: groupRow._parentKeys });
      const res = await this.server.getData(request);
      const idx = this.state.rows.indexOf(groupRow);
      this.state.rows.splice(idx + 1, 0, ...res.rows);
      this.renderer.setLoading(false);
      this.renderer.renderRows(this.state.rows, this.state.currentDisplayCols, this.state.isPivotMode, this.state.selectedRowIds, this.state.rowSelection);
    }
  }

  async refreshFullStructure() {
    this.renderer.setLoading(true);
    const res = await this.server.getData(this.buildRequest());
    this.state.currentDisplayCols = this.getSortedDisplayCols(res.dynamicPivotColumns);

    const isAllSelected = this.isAllLoadedRowsSelected();
    this.renderer.renderHeaders(this.state.currentDisplayCols, this.state.sortModel, this.state.filterModel, this.state.isPivotMode, this.state.rowSelection, isAllSelected);
    this.renderer.renderToolPanel(this.state.colDefs, this.state);
    this.state.rows = res.rows;
    this.renderer.renderRows(this.state.rows, this.state.currentDisplayCols, this.state.isPivotMode, this.state.selectedRowIds, this.state.rowSelection);
    this.renderer.setLoading(false);
  }

  async loadData() {
    this.renderer.setLoading(true);
    const res = await this.server.getData(this.buildRequest());
    this.state.rows = res.rows;
    if (this.state.isPivotMode && res.dynamicPivotColumns) {
      this.state.currentDisplayCols = this.getSortedDisplayCols(res.dynamicPivotColumns);
      const isAllSelected = this.isAllLoadedRowsSelected();
      this.renderer.renderHeaders(this.state.currentDisplayCols, this.state.sortModel, this.state.filterModel, this.state.isPivotMode, this.state.rowSelection, isAllSelected);
    }
    this.renderer.renderRows(this.state.rows, this.state.currentDisplayCols, this.state.isPivotMode, this.state.selectedRowIds, this.state.rowSelection);
    this.renderer.setLoading(false);
  }

  buildRequest(overrides = {}) {
    return {
      startRow: 0, endRow: 100,
      filterModel: this.state.filterModel, sortModel: this.state.sortModel,
      rowGroupCols: this.state.rowGroupCols, pivotCols: this.state.pivotCols,
      valueCols: this.state.valueCols, isPivotMode: this.state.isPivotMode,
      groupKeys: [], ...overrides
    };
  }
}

const generateData = () => {
  const countries = ['United States', 'China', 'Russia', 'Australia', 'Germany', 'Japan'];
  const sports = ['Swimming', 'Gymnastics', 'Athletics', 'Cycling'];
  const years = [2020, 2021, 2022];
  let data = [];
  for (let i = 0; i < 500; i++) {
    data.push({
      id: i, athlete: `Athlete ${i}`,
      country: countries[Math.floor(Math.random() * countries.length)],
      sport: sports[Math.floor(Math.random() * sports.length)],
      year: years[Math.floor(Math.random() * years.length)],
      gold: Math.floor(Math.random() * 10), silver: Math.floor(Math.random() * 5), bronze: Math.floor(Math.random() * 5)
    });
  }
  return data;
};

const colDefs = [
  { field: 'athlete', headerName: 'Athlete', width: 150, editable: true },
  {
    field: 'country', headerName: 'Country', width: 140,
    cellRenderer: (params) => {
      const map = { 'United States': '🇺🇸', 'China': '🇨🇳', 'Russia': '🇷🇺', 'Australia': '🇦🇺', 'Germany': '🇩🇪', 'Japan': '🇯🇵' };
      return `<span class="text-lg mr-2">${map[params.value] || '🏳️'}</span> ${params.value}`;
    }
  },
  { field: 'sport', headerName: 'Sport', width: 120 },
  { field: 'year', headerName: 'Year', width: 90 },
  {
    field: 'gold', headerName: 'Gold', width: 100, aggFunc: 'sum',
    cellRenderer: (params) => {
      const val = params.value || 0;
      const max = 15;
      const width = Math.min(100, (val / max) * 100);
      return `<div class="flex items-center w-full h-full"><div class="flex-1 bg-gray-200 rounded h-2 mr-2 overflow-hidden"><div class="bg-yellow-400 h-full" style="width: ${width}%"></div></div><span class="text-xs font-bold text-gray-600 w-4">${val}</span></div>`;
    }
  },
  { field: 'silver', headerName: 'Silver', width: 80, aggFunc: 'sum' },
  { field: 'bronze', headerName: 'Bronze', width: 80, aggFunc: 'sum' }
];

document.addEventListener('DOMContentLoaded', () => {
  new PivotGrid(document.getElementById('myGrid'), {
    columnDefs: colDefs,
    rowData: generateData(),
    rowSelection: 'multiple' // Configuración de selección: 'single' | 'multiple'
  });
});
