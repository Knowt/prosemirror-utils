'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var prosemirrorState = require('prosemirror-state');
var prosemirrorModel = require('prosemirror-model');
var prosemirrorTables = require('@knowt/prosemirror-tables');

// :: (nodeType: union<NodeType, [NodeType]>) → (tr: Transaction) → Transaction
// Returns a new transaction that removes a node of a given `nodeType`. It will return an original transaction if parent node hasn't been found.
//
// ```javascript
// dispatch(
//   removeParentNodeOfType(schema.nodes.table)(tr)
// );
// ```
const removeParentNodeOfType = nodeType => tr => {
  const parent = findParentNodeOfType(nodeType)(tr.selection);
  if (parent) {
    return removeNodeAtPos(parent.pos)(tr);
  }
  return tr;
};

// :: (nodeType: union<NodeType, [NodeType]>, content: union<ProseMirrorNode, Fragment>) → (tr: Transaction) → Transaction
// Returns a new transaction that replaces parent node of a given `nodeType` with the given `content`. It will return an original transaction if either parent node hasn't been found or replacing is not possible.
//
// ```javascript
// const node = schema.nodes.paragraph.createChecked({}, schema.text('new'));
//
// dispatch(
//  replaceParentNodeOfType(schema.nodes.table, node)(tr)
// );
// ```
const replaceParentNodeOfType = (nodeType, content) => tr => {
  if (!Array.isArray(nodeType)) {
    nodeType = [nodeType];
  }
  for (let i = 0, count = nodeType.length; i < count; i++) {
    const parent = findParentNodeOfType(nodeType[i])(tr.selection);
    if (parent) {
      const newTr = replaceNodeAtPos(parent.pos, content)(tr);
      if (newTr !== tr) {
        return newTr;
      }
    }
  }
  return tr;
};

// :: (tr: Transaction) → Transaction
// Returns a new transaction that removes selected node. It will return an original transaction if current selection is not a `NodeSelection`.
//
// ```javascript
// dispatch(
//   removeSelectedNode(tr)
// );
// ```
const removeSelectedNode = tr => {
  if (isNodeSelection(tr.selection)) {
    const from = tr.selection.$from.pos;
    const to = tr.selection.$to.pos;
    return cloneTr(tr.delete(from, to));
  }
  return tr;
};

// :: (content: union<ProseMirrorNode, ProseMirrorFragment>) → (tr: Transaction) → Transaction
// Returns a new transaction that replaces selected node with a given `node`, keeping NodeSelection on the new `node`.
// It will return the original transaction if either current selection is not a NodeSelection or replacing is not possible.
//
// ```javascript
// const node = schema.nodes.paragraph.createChecked({}, schema.text('new'));
// dispatch(
//   replaceSelectedNode(node)(tr)
// );
// ```
const replaceSelectedNode = content => tr => {
  if (isNodeSelection(tr.selection)) {
    const { $from, $to } = tr.selection;
    if (
      (content instanceof prosemirrorModel.Fragment &&
        $from.parent.canReplace($from.index(), $from.indexAfter(), content)) ||
      $from.parent.canReplaceWith(
        $from.index(),
        $from.indexAfter(),
        content.type
      )
    ) {
      return cloneTr(
        tr
          .replaceWith($from.pos, $to.pos, content)
          // restore node selection
          .setSelection(
            new prosemirrorState.NodeSelection(tr.doc.resolve($from.pos))
          )
      );
    }
  }
  return tr;
};

// :: (position: number, dir: ?number) → (tr: Transaction) → Transaction
// Returns a new transaction that tries to find a valid cursor selection starting at the given `position`
// and searching back if `dir` is negative, and forward if positive.
// If a valid cursor position hasn't been found, it will return the original transaction.
//
// ```javascript
// dispatch(
//   setTextSelection(5)(tr)
// );
// ```
const setTextSelection = (position, dir = 1) => tr => {
  const nextSelection = prosemirrorState.Selection.findFrom(
    tr.doc.resolve(position),
    dir,
    true
  );
  if (nextSelection) {
    return tr.setSelection(nextSelection);
  }
  return tr;
};

const isSelectableNode = node => node.type && node.type.spec.selectable;
const shouldSelectNode = node => isSelectableNode(node) && node.type.isLeaf;

const setSelection = (node, pos, tr) => {
  if (shouldSelectNode(node)) {
    return tr.setSelection(
      new prosemirrorState.NodeSelection(tr.doc.resolve(pos))
    );
  }
  return setTextSelection(pos)(tr);
};

// :: (content: union<ProseMirrorNode, Fragment>, position: ?number, tryToReplace?: boolean) → (tr: Transaction) → Transaction
// Returns a new transaction that inserts a given `content` at the current cursor position, or at a given `position`, if it is allowed by schema. If schema restricts such nesting, it will try to find an appropriate place for a given node in the document, looping through parent nodes up until the root document node.
// If `tryToReplace` is true and current selection is a NodeSelection, it will replace selected node with inserted content if its allowed by schema.
// If cursor is inside of an empty paragraph, it will try to replace that paragraph with the given content. If insertion is successful and inserted node has content, it will set cursor inside of that content.
// It will return an original transaction if the place for insertion hasn't been found.
//
// ```javascript
// const node = schema.nodes.extension.createChecked({});
// dispatch(
//   safeInsert(node)(tr)
// );
// ```
const safeInsert = (content, position, tryToReplace) => tr => {
  const hasPosition = typeof position === 'number';
  const { $from } = tr.selection;
  const $insertPos = hasPosition
    ? tr.doc.resolve(position)
    : isNodeSelection(tr.selection)
    ? tr.doc.resolve($from.pos + 1)
    : $from;
  const { parent } = $insertPos;

  // try to replace selected node
  if (isNodeSelection(tr.selection) && tryToReplace) {
    const oldTr = tr;
    tr = replaceSelectedNode(content)(tr);
    if (oldTr !== tr) {
      return tr;
    }
  }

  // try to replace an empty paragraph
  if (isEmptyParagraph(parent)) {
    const oldTr = tr;
    tr = replaceParentNodeOfType(parent.type, content)(tr);
    if (oldTr !== tr) {
      const pos = isSelectableNode(content)
        ? // for selectable node, selection position would be the position of the replaced parent
          $insertPos.before($insertPos.depth)
        : $insertPos.pos;
      return setSelection(content, pos, tr);
    }
  }

  // given node is allowed at the current cursor position
  if (canInsert($insertPos, content)) {
    tr.insert($insertPos.pos, content);
    const pos = hasPosition
      ? $insertPos.pos
      : isSelectableNode(content)
      ? // for atom nodes selection position after insertion is the previous pos
        tr.selection.$anchor.pos - 1
      : tr.selection.$anchor.pos;
    return cloneTr(setSelection(content, pos, tr));
  }

  // looking for a place in the doc where the node is allowed
  for (let i = $insertPos.depth; i > 0; i--) {
    const pos = $insertPos.after(i);
    const $pos = tr.doc.resolve(pos);
    if (canInsert($pos, content)) {
      tr.insert(pos, content);
      return cloneTr(setSelection(content, pos, tr));
    }
  }
  return tr;
};

// :: (nodeType: union<NodeType, [NodeType]>, type: ?union<NodeType, null>, attrs: ?union<Object, null>, marks?: [Mark]) → (tr: Transaction) → Transaction
// Returns a transaction that changes the type, attributes, and/or marks of the parent node of a given `nodeType`.
//
// ```javascript
// const node = schema.nodes.extension.createChecked({});
// dispatch(
//   setParentNodeMarkup(schema.nodes.panel, null, { panelType })(tr);
// );
// ```
const setParentNodeMarkup = (nodeType, type, attrs, marks) => tr => {
  const parent = findParentNodeOfType(nodeType)(tr.selection);
  if (parent) {
    return cloneTr(
      tr.setNodeMarkup(
        parent.pos,
        type,
        Object.assign({}, parent.node.attrs, attrs),
        marks
      )
    );
  }
  return tr;
};

// :: (nodeType: union<NodeType, [NodeType]>) → (tr: Transaction) → Transaction
// Returns a new transaction that sets a `NodeSelection` on a parent node of a `given nodeType`.
//
// ```javascript
// dispatch(
//   selectParentNodeOfType([tableCell, tableHeader])(state.tr)
// );
// ```
const selectParentNodeOfType = nodeType => tr => {
  if (!isNodeSelection(tr.selection)) {
    const parent = findParentNodeOfType(nodeType)(tr.selection);
    if (parent) {
      return cloneTr(
        tr.setSelection(
          prosemirrorState.NodeSelection.create(tr.doc, parent.pos)
        )
      );
    }
  }
  return tr;
};

// :: (tr: Transaction) → Transaction
// Returns a new transaction that deletes previous node.
//
// ```javascript
// dispatch(
//   removeNodeBefore(state.tr)
// );
// ```
const removeNodeBefore = tr => {
  const position = findPositionOfNodeBefore(tr.selection);
  if (typeof position === 'number') {
    return removeNodeAtPos(position)(tr);
  }
  return tr;
};

// :: (selection: Selection) → boolean
// Checks if current selection is a `NodeSelection`.
//
// ```javascript
// if (isNodeSelection(tr.selection)) {
//   // ...
// }
// ```
const isNodeSelection = selection => {
  return selection instanceof prosemirrorState.NodeSelection;
};

// (nodeType: union<NodeType, [NodeType]>) → boolean
// Checks if the type a given `node` equals to a given `nodeType`.
const equalNodeType = (nodeType, node) => {
  return (
    (Array.isArray(nodeType) && nodeType.indexOf(node.type) > -1) ||
    node.type === nodeType
  );
};

// (tr: Transaction) → Transaction
// Creates a new transaction object from a given transaction
const cloneTr = tr => {
  return Object.assign(Object.create(tr), tr).setTime(Date.now());
};

// (position: number, content: union<ProseMirrorNode, Fragment>) → (tr: Transaction) → Transaction
// Returns a `replace` transaction that replaces a node at a given position with the given `content`.
// It will return the original transaction if replacing is not possible.
// `position` should point at the position immediately before the node.
const replaceNodeAtPos = (position, content) => tr => {
  const node = tr.doc.nodeAt(position);
  const $pos = tr.doc.resolve(position);
  if (canReplace($pos, content)) {
    tr = tr.replaceWith(position, position + node.nodeSize, content);
    const start = tr.selection.$from.pos - 1;
    // put cursor inside of the inserted node
    tr = setTextSelection(Math.max(start, 0), -1)(tr);
    // move cursor to the start of the node
    tr = setTextSelection(tr.selection.$from.start())(tr);
    return cloneTr(tr);
  }
  return tr;
};

// ($pos: ResolvedPos, doc: ProseMirrorNode, content: union<ProseMirrorNode, Fragment>, ) → boolean
// Checks if replacing a node at a given `$pos` inside of the `doc` node with the given `content` is possible.
const canReplace = ($pos, content) => {
  const node = $pos.node($pos.depth);
  return (
    node &&
    node.type.validContent(
      content instanceof prosemirrorModel.Fragment
        ? content
        : prosemirrorModel.Fragment.from(content)
    )
  );
};

// (position: number) → (tr: Transaction) → Transaction
// Returns a `delete` transaction that removes a node at a given position with the given `node`.
// `position` should point at the position immediately before the node.
const removeNodeAtPos = position => tr => {
  const node = tr.doc.nodeAt(position);
  return cloneTr(tr.delete(position, position + node.nodeSize));
};

// (schema: Schema) → {[key: string]: NodeType}
// Returns a map where keys are tableRoles and values are NodeTypes.
const tableNodeTypes = schema => {
  if (schema.cached.tableNodeTypes) {
    return schema.cached.tableNodeTypes;
  }
  const roles = {};
  Object.keys(schema.nodes).forEach(type => {
    const nodeType = schema.nodes[type];
    if (nodeType.spec.tableRole) {
      roles[nodeType.spec.tableRole] = nodeType;
    }
  });
  schema.cached.tableNodeTypes = roles;
  return roles;
};

// :: ($pos: ResolvedPos, content: union<ProseMirrorNode, Fragment>) → boolean
// Checks if a given `content` can be inserted at the given `$pos`
//
// ```javascript
// const { selection: { $from } } = state;
// const node = state.schema.nodes.atom.createChecked();
// if (canInsert($from, node)) {
//   // ...
// }
// ```
const canInsert = ($pos, content) => {
  const index = $pos.index();

  if (content instanceof prosemirrorModel.Fragment) {
    return $pos.parent.canReplace(index, index, content);
  } else if (content instanceof prosemirrorModel.Node) {
    return $pos.parent.canReplaceWith(index, index, content.type);
  }
  return false;
};

// (node: ProseMirrorNode) → boolean
// Checks if a given `node` is an empty paragraph
const isEmptyParagraph = node => {
  return !node || (node.type.name === 'paragraph' && node.nodeSize === 2);
};

// ($pos: ResolvedPos) → ?{pos: number, start: number, node: ProseMirrorNode}
// Iterates over parent nodes, returning a table node closest to a given `$pos`.
//
// ```javascript
// const table = findTableClosestToPos(state.doc.resolve(10));
// ```
const findTableClosestToPos = $pos => {
  const predicate = node =>
    node.type.spec.tableRole && /table/i.test(node.type.spec.tableRole);
  return findParentNodeClosestToPos($pos, predicate);
};

const createCell = (cellType, cellContent = null) => {
  if (cellContent) {
    return cellType.createChecked(null, cellContent);
  }

  return cellType.createAndFill();
};

// (rect: {left: number, right: number, top: number, bottom: number}) → (selection: Selection) → boolean
// Checks if a given CellSelection rect is selected
const isRectSelected = rect => selection => {
  const map = prosemirrorTables.TableMap.get(selection.$anchorCell.node(-1));
  const start = selection.$anchorCell.start(-1);
  const cells = map.cellsInRect(rect);
  const selectedCells = map.cellsInRect(
    map.rectBetween(
      selection.$anchorCell.pos - start,
      selection.$headCell.pos - start
    )
  );

  for (let i = 0, count = cells.length; i < count; i++) {
    if (selectedCells.indexOf(cells[i]) === -1) {
      return false;
    }
  }

  return true;
};

// This function transposes an array of array flipping the columns for rows,
// transposition is a familiar algebra concept;
// you can get more details here:
// https://en.wikipedia.org/wiki/Transpose
//
// ```javascript
//
//  const arr = [
//    ['a1', 'a2', 'a3'],
//    ['b1', 'b2', 'b3'],
//    ['c1', 'c2', 'c3'],
//    ['d1', 'd2', 'd3'],
//  ];
//
//  const result = transpose(arr);
//
//  result === [
//    ['a1', 'b1', 'c1', 'd1'],
//    ['a2', 'b2', 'c2', 'd2'],
//    ['a3', 'b3', 'c3', 'd3'],
//  ]
// ```
const transpose = array => {
  return array[0].map((_, i) => {
    return array.map(column => column[i]);
  });
};

// :: (tableNode: Node) -> Array<Node>
// This function will transform the table node
// into a matrix of rows and columns respecting merged cells,
// for example this table will be convert to the below:
//
// ```
//  ____________________________
// |      |      |             |
// |  A1  |  B1  |     C1      |
// |______|______|______ ______|
// |      |             |      |
// |  A2  |     B2      |      |
// |______|______ ______|      |
// |      |      |      |  D1  |
// |  A3  |  B3  |  C2  |      |
// |______|______|______|______|
// ```
//
//
// ```javascript
// array = [
//   [A1, B1, C1, null],
//   [A2, B2, null, D1],
//   [A3. B3, C2, null],
// ]
// ```
const convertTableNodeToArrayOfRows = tableNode => {
  const map = prosemirrorTables.TableMap.get(tableNode);
  const rows = [];
  for (let rowIndex = 0; rowIndex < map.height; rowIndex++) {
    const rowCells = [];
    const seen = {};

    for (let colIndex = 0; colIndex < map.width; colIndex++) {
      const cellPos = map.map[rowIndex * map.width + colIndex];
      const cell = tableNode.nodeAt(cellPos);
      const rect = map.findCell(cellPos);
      if (seen[cellPos] || rect.top !== rowIndex) {
        rowCells.push(null);
        continue;
      }
      seen[cellPos] = true;

      rowCells.push(cell);
    }

    rows.push(rowCells);
  }

  return rows;
};

// :: (tableNode: Node, tableArray: Array<Node>) -> Node
// This function will transform a matrix of nodes
// into table node respecting merged cells and rows configurations,
// for example this array will be convert to the table below:
//
// ```javascript
// array = [
//   [A1, B1, C1, null],
//   [A2, B2, null, D1],
//   [A3. B3, C2, null],
// ]
// ```
//
// ```
//  ____________________________
// |      |      |             |
// |  A1  |  B1  |     C1      |
// |______|______|______ ______|
// |      |             |      |
// |  A2  |     B2      |      |
// |______|______ ______|      |
// |      |      |      |  D1  |
// |  A3  |  B3  |  C2  |      |
// |______|______|______|______|
// ```
//
const convertArrayOfRowsToTableNode = (tableNode, arrayOfNodes) => {
  const rowsPM = [];
  const map = prosemirrorTables.TableMap.get(tableNode);
  for (let rowIndex = 0; rowIndex < map.height; rowIndex++) {
    const row = tableNode.child(rowIndex);
    const rowCells = [];

    for (let colIndex = 0; colIndex < map.width; colIndex++) {
      if (!arrayOfNodes[rowIndex][colIndex]) {
        continue;
      }
      const cellPos = map.map[rowIndex * map.width + colIndex];

      const cell = arrayOfNodes[rowIndex][colIndex];
      const oldCell = tableNode.nodeAt(cellPos);
      const newCell = oldCell.type.createChecked(
        Object.assign({}, cell.attrs),
        cell.content,
        cell.marks
      );
      rowCells.push(newCell);
    }

    rowsPM.push(row.type.createChecked(row.attrs, rowCells, row.marks));
  }

  const newTable = tableNode.type.createChecked(
    tableNode.attrs,
    rowsPM,
    tableNode.marks
  );

  return newTable;
};

const moveTableColumn = (table, indexesOrigin, indexesTarget, direction) => {
  let rows = transpose(convertTableNodeToArrayOfRows(table.node));

  rows = moveRowInArrayOfRows(rows, indexesOrigin, indexesTarget, direction);
  rows = transpose(rows);

  return convertArrayOfRowsToTableNode(table.node, rows);
};

const moveTableRow = (table, indexesOrigin, indexesTarget, direction) => {
  let rows = convertTableNodeToArrayOfRows(table.node);

  rows = moveRowInArrayOfRows(rows, indexesOrigin, indexesTarget, direction);

  return convertArrayOfRowsToTableNode(table.node, rows);
};

const moveRowInArrayOfRows = (
  rows,
  indexesOrigin,
  indexesTarget,
  directionOverride
) => {
  let direction = indexesOrigin[0] > indexesTarget[0] ? -1 : 1;

  const rowsExtracted = rows.splice(indexesOrigin[0], indexesOrigin.length);
  const positionOffset = rowsExtracted.length % 2 === 0 ? 1 : 0;
  let target;

  if (directionOverride === -1 && direction === 1) {
    target = indexesTarget[0] - 1;
  } else if (directionOverride === 1 && direction === -1) {
    target = indexesTarget[indexesTarget.length - 1] - positionOffset + 1;
  } else {
    target =
      direction === -1
        ? indexesTarget[0]
        : indexesTarget[indexesTarget.length - 1] - positionOffset;
  }

  rows.splice.apply(rows, [target, 0].concat(rowsExtracted));
  return rows;
};

const checkInvalidMovements = (originIndex, targetIndex, targets, type) => {
  const direction = originIndex > targetIndex ? -1 : 1;
  const errorMessage = `Target position is invalid, you can't move the ${type} ${originIndex} to ${targetIndex}, the target can't be split. You could use tryToFit option.`;

  if (direction === 1) {
    if (targets.slice(0, targets.length - 1).indexOf(targetIndex) !== -1) {
      throw new Error(errorMessage);
    }
  } else {
    if (targets.slice(1).indexOf(targetIndex) !== -1) {
      throw new Error(errorMessage);
    }
  }

  return true;
};

// :: (predicate: (node: ProseMirrorNode) → boolean) → (selection: Selection) → ?{pos: number, start: number, depth: number, node: ProseMirrorNode}
// Iterates over parent nodes, returning the closest node and its start position `predicate` returns truthy for. `start` points to the start position of the node, `pos` points directly before the node.
//
// ```javascript
// const predicate = node => node.type === schema.nodes.blockquote;
// const parent = findParentNode(predicate)(selection);
// ```
const findParentNode = predicate => ({ $from }) =>
  findParentNodeClosestToPos($from, predicate);

// :: ($pos: ResolvedPos, predicate: (node: ProseMirrorNode) → boolean) → ?{pos: number, start: number, depth: number, node: ProseMirrorNode}
// Iterates over parent nodes starting from the given `$pos`, returning the closest node and its start position `predicate` returns truthy for. `start` points to the start position of the node, `pos` points directly before the node.
//
// ```javascript
// const predicate = node => node.type === schema.nodes.blockquote;
// const parent = findParentNodeClosestToPos(state.doc.resolve(5), predicate);
// ```
const findParentNodeClosestToPos = ($pos, predicate) => {
  for (let i = $pos.depth; i > 0; i--) {
    const node = $pos.node(i);
    if (predicate(node)) {
      return {
        pos: i > 0 ? $pos.before(i) : 0,
        start: $pos.start(i),
        depth: i,
        node
      };
    }
  }
};

// :: (predicate: (node: ProseMirrorNode) → boolean, domAtPos: (pos: number) → {node: dom.Node, offset: number}) → (selection: Selection) → ?dom.Node
// Iterates over parent nodes, returning DOM reference of the closest node `predicate` returns truthy for.
//
// ```javascript
// const domAtPos = view.domAtPos.bind(view);
// const predicate = node => node.type === schema.nodes.table;
// const parent = findParentDomRef(predicate, domAtPos)(selection); // <table>
// ```
const findParentDomRef = (predicate, domAtPos) => selection => {
  const parent = findParentNode(predicate)(selection);
  if (parent) {
    return findDomRefAtPos(parent.pos, domAtPos);
  }
};

// :: (predicate: (node: ProseMirrorNode) → boolean) → (selection: Selection) → boolean
// Checks if there's a parent node `predicate` returns truthy for.
//
// ```javascript
// if (hasParentNode(node => node.type === schema.nodes.table)(selection)) {
//   // ....
// }
// ```
const hasParentNode = predicate => selection => {
  return !!findParentNode(predicate)(selection);
};

// :: (nodeType: union<NodeType, [NodeType]>) → (selection: Selection) → ?{pos: number, start: number, depth: number, node: ProseMirrorNode}
// Iterates over parent nodes, returning closest node of a given `nodeType`. `start` points to the start position of the node, `pos` points directly before the node.
//
// ```javascript
// const parent = findParentNodeOfType(schema.nodes.paragraph)(selection);
// ```
const findParentNodeOfType = nodeType => selection => {
  return findParentNode(node => equalNodeType(nodeType, node))(selection);
};

// :: ($pos: ResolvedPos, nodeType: union<NodeType, [NodeType]>) → ?{pos: number, start: number, depth: number, node: ProseMirrorNode}
// Iterates over parent nodes starting from the given `$pos`, returning closest node of a given `nodeType`. `start` points to the start position of the node, `pos` points directly before the node.
//
// ```javascript
// const parent = findParentNodeOfTypeClosestToPos(state.doc.resolve(10), schema.nodes.paragraph);
// ```
const findParentNodeOfTypeClosestToPos = ($pos, nodeType) => {
  return findParentNodeClosestToPos($pos, node =>
    equalNodeType(nodeType, node)
  );
};

// :: (nodeType: union<NodeType, [NodeType]>) → (selection: Selection) → boolean
// Checks if there's a parent node of a given `nodeType`.
//
// ```javascript
// if (hasParentNodeOfType(schema.nodes.table)(selection)) {
//   // ....
// }
// ```
const hasParentNodeOfType = nodeType => selection => {
  return hasParentNode(node => equalNodeType(nodeType, node))(selection);
};

// :: (nodeType: union<NodeType, [NodeType]>, domAtPos: (pos: number) → {node: dom.Node, offset: number}) → (selection: Selection) → ?dom.Node
// Iterates over parent nodes, returning DOM reference of the closest node of a given `nodeType`.
//
// ```javascript
// const domAtPos = view.domAtPos.bind(view);
// const parent = findParentDomRefOfType(schema.nodes.codeBlock, domAtPos)(selection); // <pre>
// ```
const findParentDomRefOfType = (nodeType, domAtPos) => selection => {
  return findParentDomRef(
    node => equalNodeType(nodeType, node),
    domAtPos
  )(selection);
};

// :: (nodeType: union<NodeType, [NodeType]>) → (selection: Selection) → ?{pos: number, start: number, depth: number, node: ProseMirrorNode}
// Returns a node of a given `nodeType` if it is selected. `start` points to the start position of the node, `pos` points directly before the node.
//
// ```javascript
// const { extension, inlineExtension, bodiedExtension } = schema.nodes;
// const selectedNode = findSelectedNodeOfType([
//   extension,
//   inlineExtension,
//   bodiedExtension,
// ])(selection);
// ```
const findSelectedNodeOfType = nodeType => selection => {
  if (isNodeSelection(selection)) {
    const { node, $from } = selection;
    if (equalNodeType(nodeType, node)) {
      return { node, pos: $from.pos, depth: $from.depth };
    }
  }
};

// :: (selection: Selection) → ?number
// Returns position of the previous node.
//
// ```javascript
// const pos = findPositionOfNodeBefore(tr.selection);
// ```
const findPositionOfNodeBefore = selection => {
  const { nodeBefore } = selection.$from;
  const maybeSelection = prosemirrorState.Selection.findFrom(
    selection.$from,
    -1
  );
  if (maybeSelection && nodeBefore) {
    // leaf node
    const parent = findParentNodeOfType(nodeBefore.type)(maybeSelection);
    if (parent) {
      return parent.pos;
    }
    return maybeSelection.$from.pos;
  }
};

// :: (position: number, domAtPos: (pos: number) → {node: dom.Node, offset: number}) → dom.Node
// Returns DOM reference of a node at a given `position`. If the node type is of type `TEXT_NODE` it will return the reference of the parent node.
//
// ```javascript
// const domAtPos = view.domAtPos.bind(view);
// const ref = findDomRefAtPos($from.pos, domAtPos);
// ```
const findDomRefAtPos = (position, domAtPos) => {
  const dom = domAtPos(position);
  const node = dom.node.childNodes[dom.offset];

  if (dom.node.nodeType === Node.TEXT_NODE) {
    return dom.node.parentNode;
  }

  if (!node || node.nodeType === Node.TEXT_NODE) {
    return dom.node;
  }

  return node;
};

// :: (node: ProseMirrorNode, descend: ?boolean) → [{ node: ProseMirrorNode, pos: number }]
// Flattens descendants of a given `node`. It doesn't descend into a node when descend argument is `false` (defaults to `true`).
//
// ```javascript
// const children = flatten(node);
// ```
const flatten = (node, descend = true) => {
  if (!node) {
    throw new Error('Invalid "node" parameter');
  }
  const result = [];
  node.descendants((child, pos) => {
    result.push({ node: child, pos });
    if (!descend) {
      return false;
    }
  });
  return result;
};

// :: (node: ProseMirrorNode, predicate: (node: ProseMirrorNode) → boolean, descend: ?boolean) → [{ node: ProseMirrorNode, pos: number }]
// Iterates over descendants of a given `node`, returning child nodes predicate returns truthy for. It doesn't descend into a node when descend argument is `false` (defaults to `true`).
//
// ```javascript
// const textNodes = findChildren(node, child => child.isText, false);
// ```
const findChildren = (node, predicate, descend) => {
  if (!node) {
    throw new Error('Invalid "node" parameter');
  } else if (!predicate) {
    throw new Error('Invalid "predicate" parameter');
  }
  return flatten(node, descend).filter(child => predicate(child.node));
};

// :: (node: ProseMirrorNode, descend: ?boolean) → [{ node: ProseMirrorNode, pos: number }]
// Returns text nodes of a given `node`. It doesn't descend into a node when descend argument is `false` (defaults to `true`).
//
// ```javascript
// const textNodes = findTextNodes(node);
// ```
const findTextNodes = (node, descend) => {
  return findChildren(node, child => child.isText, descend);
};

// :: (node: ProseMirrorNode, descend: ?boolean) → [{ node: ProseMirrorNode, pos: number }]
// Returns inline nodes of a given `node`. It doesn't descend into a node when descend argument is `false` (defaults to `true`).
//
// ```javascript
// const inlineNodes = findInlineNodes(node);
// ```
const findInlineNodes = (node, descend) => {
  return findChildren(node, child => child.isInline, descend);
};

// :: (node: ProseMirrorNode, descend: ?boolean) → [{ node: ProseMirrorNode, pos: number }]
// Returns block descendants of a given `node`. It doesn't descend into a node when descend argument is `false` (defaults to `true`).
//
// ```javascript
// const blockNodes = findBlockNodes(node);
// ```
const findBlockNodes = (node, descend) => {
  return findChildren(node, child => child.isBlock, descend);
};

// :: (node: ProseMirrorNode, predicate: (attrs: ?Object) → boolean, descend: ?boolean) → [{ node: ProseMirrorNode, pos: number }]
// Iterates over descendants of a given `node`, returning child nodes predicate returns truthy for. It doesn't descend into a node when descend argument is `false` (defaults to `true`).
//
// ```javascript
// const mergedCells = findChildrenByAttr(table, attrs => attrs.colspan === 2);
// ```
const findChildrenByAttr = (node, predicate, descend) => {
  return findChildren(node, child => !!predicate(child.attrs), descend);
};

// :: (node: ProseMirrorNode, nodeType: NodeType, descend: ?boolean) → [{ node: ProseMirrorNode, pos: number }]
// Iterates over descendants of a given `node`, returning child nodes of a given nodeType. It doesn't descend into a node when descend argument is `false` (defaults to `true`).
//
// ```javascript
// const cells = findChildrenByType(table, schema.nodes.tableCell);
// ```
const findChildrenByType = (node, nodeType, descend) => {
  return findChildren(node, child => child.type === nodeType, descend);
};

// :: (node: ProseMirrorNode, markType: markType, descend: ?boolean) → [{ node: ProseMirrorNode, pos: number }]
// Iterates over descendants of a given `node`, returning child nodes that have a mark of a given markType. It doesn't descend into a `node` when descend argument is `false` (defaults to `true`).
//
// ```javascript
// const nodes = findChildrenByMark(state.doc, schema.marks.strong);
// ```
const findChildrenByMark = (node, markType, descend) => {
  return findChildren(node, child => markType.isInSet(child.marks), descend);
};

// :: (node: ProseMirrorNode, nodeType: NodeType) → boolean
// Returns `true` if a given node contains nodes of a given `nodeType`
//
// ```javascript
// if (contains(panel, schema.nodes.listItem)) {
//   // ...
// }
// ```
const contains = (node, nodeType) => {
  return !!findChildrenByType(node, nodeType).length;
};

// :: (selection: Selection) → ?{pos: number, start: number, node: ProseMirrorNode}
// Iterates over parent nodes, returning the closest table node.
//
// ```javascript
// const table = findTable(selection);
// ```
const findTable = selection =>
  findParentNode(
    node => node.type.spec.tableRole && node.type.spec.tableRole === 'table'
  )(selection);

// :: (selection: Selection) → boolean
// Checks if current selection is a `CellSelection`.
//
// ```javascript
// if (isCellSelection(selection)) {
//   // ...
// }
// ```
const isCellSelection = selection => {
  return selection instanceof prosemirrorTables.CellSelection;
};

// :: (selection: Selection) → ?{left: number, right: number, top: number, bottom: number}
// Get the selection rectangle. Returns `undefined` if selection is not a CellSelection.
//
// ```javascript
// const rect = getSelectionRect(selection);
// ```
const getSelectionRect = selection => {
  if (!isCellSelection(selection)) {
    return;
  }
  const start = selection.$anchorCell.start(-1);
  const map = prosemirrorTables.TableMap.get(selection.$anchorCell.node(-1));
  return map.rectBetween(
    selection.$anchorCell.pos - start,
    selection.$headCell.pos - start
  );
};

// :: (columnIndex: number) → (selection: Selection) → boolean
// Checks if entire column at index `columnIndex` is selected.
//
// ```javascript
// const className = isColumnSelected(i)(selection) ? 'selected' : '';
// ```
const isColumnSelected = columnIndex => selection => {
  if (isCellSelection(selection)) {
    const map = prosemirrorTables.TableMap.get(selection.$anchorCell.node(-1));
    return isRectSelected({
      left: columnIndex,
      right: columnIndex + 1,
      top: 0,
      bottom: map.height
    })(selection);
  }

  return false;
};

// :: (rowIndex: number) → (selection: Selection) → boolean
// Checks if entire row at index `rowIndex` is selected.
//
// ```javascript
// const className = isRowSelected(i)(selection) ? 'selected' : '';
// ```
const isRowSelected = rowIndex => selection => {
  if (isCellSelection(selection)) {
    const map = prosemirrorTables.TableMap.get(selection.$anchorCell.node(-1));
    return isRectSelected({
      left: 0,
      right: map.width,
      top: rowIndex,
      bottom: rowIndex + 1
    })(selection);
  }

  return false;
};

// :: (selection: Selection) → boolean
// Checks if entire table is selected
//
// ```javascript
// const className = isTableSelected(selection) ? 'selected' : '';
// ```
const isTableSelected = selection => {
  if (isCellSelection(selection)) {
    const map = prosemirrorTables.TableMap.get(selection.$anchorCell.node(-1));
    return isRectSelected({
      left: 0,
      right: map.width,
      top: 0,
      bottom: map.height
    })(selection);
  }

  return false;
};

// :: (columnIndex: union<number, [number]>) → (selection: Selection) → ?[{pos: number, start: number, node: ProseMirrorNode}]
// Returns an array of cells in a column(s), where `columnIndex` could be a column index or an array of column indexes.
//
// ```javascript
// const cells = getCellsInColumn(i)(selection); // [{node, pos}, {node, pos}]
// ```
const getCellsInColumn = columnIndex => selection => {
  const table = findTable(selection);
  if (table) {
    const map = prosemirrorTables.TableMap.get(table.node);
    const indexes = Array.isArray(columnIndex)
      ? columnIndex
      : Array.from([columnIndex]);
    return indexes.reduce((acc, index) => {
      if (index >= 0 && index <= map.width - 1) {
        const cells = map.cellsInRect({
          left: index,
          right: index + 1,
          top: 0,
          bottom: map.height
        });
        return acc.concat(
          cells.map(nodePos => {
            const node = table.node.nodeAt(nodePos);
            const pos = nodePos + table.start;
            return { pos, start: pos + 1, node };
          })
        );
      }
    }, []);
  }
};

// :: (rowIndex: union<number, [number]>) → (selection: Selection) → ?[{pos: number, start: number, node: ProseMirrorNode}]
// Returns an array of cells in a row(s), where `rowIndex` could be a row index or an array of row indexes.
//
// ```javascript
// const cells = getCellsInRow(i)(selection); // [{node, pos}, {node, pos}]
// ```
const getCellsInRow = rowIndex => selection => {
  const table = findTable(selection);
  if (table) {
    const map = prosemirrorTables.TableMap.get(table.node);
    const indexes = Array.isArray(rowIndex) ? rowIndex : Array.from([rowIndex]);
    return indexes.reduce((acc, index) => {
      if (index >= 0 && index <= map.height - 1) {
        const cells = map.cellsInRect({
          left: 0,
          right: map.width,
          top: index,
          bottom: index + 1
        });
        return acc.concat(
          cells.map(nodePos => {
            const node = table.node.nodeAt(nodePos);
            const pos = nodePos + table.start;
            return { pos, start: pos + 1, node };
          })
        );
      }
    }, []);
  }
};

// :: (selection: Selection) → ?[{pos: number, start: number, node: ProseMirrorNode}]
// Returns an array of all cells in a table.
//
// ```javascript
// const cells = getCellsInTable(selection); // [{node, pos}, {node, pos}]
// ```
const getCellsInTable = selection => {
  const table = findTable(selection);
  if (table) {
    const map = prosemirrorTables.TableMap.get(table.node);
    const cells = map.cellsInRect({
      left: 0,
      right: map.width,
      top: 0,
      bottom: map.height
    });
    return cells.map(nodePos => {
      const node = table.node.nodeAt(nodePos);
      const pos = nodePos + table.start;
      return { pos, start: pos + 1, node };
    });
  }
};

const select = type => (index, expand) => tr => {
  const table = findTable(tr.selection);
  const isRowSelection = type === 'row';
  if (table) {
    const map = prosemirrorTables.TableMap.get(table.node);

    // Check if the index is valid
    if (index >= 0 && index < (isRowSelection ? map.height : map.width)) {
      let left = isRowSelection ? 0 : index;
      let top = isRowSelection ? index : 0;
      let right = isRowSelection ? map.width : index + 1;
      let bottom = isRowSelection ? index + 1 : map.height;

      if (expand) {
        const cell = findCellClosestToPos(tr.selection.$from);
        if (!cell) {
          return tr;
        }

        const selRect = map.findCell(cell.pos - table.start);
        if (isRowSelection) {
          top = Math.min(top, selRect.top);
          bottom = Math.max(bottom, selRect.bottom);
        } else {
          left = Math.min(left, selRect.left);
          right = Math.max(right, selRect.right);
        }
      }

      const cellsInFirstRow = map.cellsInRect({
        left,
        top,
        right: isRowSelection ? right : left + 1,
        bottom: isRowSelection ? top + 1 : bottom
      });

      const cellsInLastRow =
        bottom - top === 1
          ? cellsInFirstRow
          : map.cellsInRect({
              left: isRowSelection ? left : right - 1,
              top: isRowSelection ? bottom - 1 : top,
              right,
              bottom
            });

      const head = table.start + cellsInFirstRow[0];
      const anchor = table.start + cellsInLastRow[cellsInLastRow.length - 1];
      const $head = tr.doc.resolve(head);
      const $anchor = tr.doc.resolve(anchor);

      return cloneTr(
        tr.setSelection(new prosemirrorTables.CellSelection($anchor, $head))
      );
    }
  }
  return tr;
};

// :: (columnIndex: number, expand: ?boolean) → (tr: Transaction) → Transaction
// Returns a new transaction that creates a `CellSelection` on a column at index `columnIndex`.
// Use the optional `expand` param to extend from current selection.
//
// ```javascript
// dispatch(
//   selectColumn(i)(state.tr)
// );
// ```
const selectColumn = select('column');

// :: (rowIndex: number, expand: ?boolean) → (tr: Transaction) → Transaction
// Returns a new transaction that creates a `CellSelection` on a column at index `rowIndex`.
// Use the optional `expand` param to extend from current selection.
//
// ```javascript
// dispatch(
//   selectRow(i)(state.tr)
// );
// ```
const selectRow = select('row');

// :: (selection: Selection) → (tr: Transaction) → Transaction
// Returns a new transaction that creates a `CellSelection` on the entire table.
//
// ```javascript
// dispatch(
//   selectTable(i)(state.tr)
// );
// ```
const selectTable = tr => {
  const table = findTable(tr.selection);
  if (table) {
    const { map } = prosemirrorTables.TableMap.get(table.node);
    if (map && map.length) {
      const head = table.start + map[0];
      const anchor = table.start + map[map.length - 1];
      const $head = tr.doc.resolve(head);
      const $anchor = tr.doc.resolve(anchor);

      return cloneTr(
        tr.setSelection(new prosemirrorTables.CellSelection($anchor, $head))
      );
    }
  }
  return tr;
};

// :: (cell: {pos: number, node: ProseMirrorNode}, schema: Schema) → (tr: Transaction) → Transaction
// Returns a new transaction that clears the content of a given `cell`.
//
// ```javascript
// const $pos = state.doc.resolve(13);
// dispatch(
//   emptyCell(findCellClosestToPos($pos), state.schema)(state.tr)
// );
// ```
const emptyCell = (cell, schema) => tr => {
  if (cell) {
    const { content } = tableNodeTypes(schema).cell.createAndFill();
    if (!cell.node.content.eq(content)) {
      tr.replaceWith(cell.pos + 1, cell.pos + cell.node.nodeSize, content);
      return cloneTr(tr);
    }
  }
  return tr;
};

// :: (columnIndex: number) → (tr: Transaction) → Transaction
// Returns a new transaction that adds a new column at index `columnIndex`.
//
// ```javascript
// dispatch(
//   addColumnAt(i)(state.tr)
// );
// ```
const addColumnAt = columnIndex => tr => {
  const table = findTable(tr.selection);
  if (table) {
    const map = prosemirrorTables.TableMap.get(table.node);
    if (columnIndex >= 0 && columnIndex <= map.width) {
      return cloneTr(
        prosemirrorTables.addColumn(
          tr,
          {
            map,
            tableStart: table.start,
            table: table.node
          },
          columnIndex
        )
      );
    }
  }
  return tr;
};

// :: (originRowIndex: number, targetRowIndex: targetColumnIndex, options?: MovementOptions) → (tr: Transaction) → Transaction
// Returns a new transaction that moves the origin row to the target index;
//
// by default "tryToFit" is false, that means if you try to move a row to a place
// where we will need to split a row with merged cells it'll throw an exception, for example:
//
// ```
//      ____________________________
//     |      |      |             |
//  0  |  A1  |  B1  |     C1      |
//     |______|______|______ ______|
//     |      |             |      |
//  1  |  A2  |     B2      |      |
//     |______|______ ______|      |
//     |      |      |      |  D1  |
//  2  |  A3  |  B3  |  C2  |      |
//     |______|______|______|______|
// ```
//
// if you try to move the row 0 to the row index 1 with tryToFit false,
// it'll throw an exception since you can't split the row 1;
// but if "tryToFit" is true, it'll move the row using the current direction.
//
// We defined current direction using the target and origin values
// if the origin is greater than the target, that means the course is `bottom-to-top`,
// so the `tryToFit` logic will use this direction to determine
// if we should move the column to the right or the left.
//
// for example, if you call the function using `moveRow(0, 1, { tryToFit: true })`
// the result will be:
// ```
//      ____________________________
//     |      |             |      |
//  0  |  A2  |     B2      |      |
//     |______|______ ______|      |
//     |      |      |      |  D1  |
//  1  |  A3  |  B3  |  C2  |      |
//     |______|______|______|______|
//     |      |      |             |
//  2  |  A1  |  B1  |     C1      |
//     |______|______|______ ______|
// ```
//
// since we could put the row zero on index one,
// we pushed to the best place to fit the row index 0,
// in this case, row index 2.
//
//
// -------- HOW TO OVERRIDE DIRECTION --------
//
// If you set "tryToFit" to "true", it will try to figure out the best direction
// place to fit using the origin and target index, for example:
//
//
// ```
//      ____________________________
//     |      |      |             |
//  0  |  A1  |  B1  |     C1      |
//     |______|______|______ ______|
//     |      |             |      |
//  1  |  A2  |     B2      |      |
//     |______|______ ______|      |
//     |      |      |      |  D1  |
//  2  |  A3  |  B3  |  C2  |      |
//     |______|______|______|______|
//     |      |             |      |
//  3  |  A4  |     B4      |      |
//     |______|______ ______|      |
//     |      |      |      |  D2  |
//  4  |  A5  |  B5  |  C3  |      |
//     |______|______|______|______|
// ```
//
//
// If you try to move the row 0 to row index 4 with "tryToFit" enabled, by default,
// the code will put it on after the merged rows,
// but you can override it using the "direction" option.
//
// -1: Always put the origin before the target
// ```
//      ____________________________
//     |      |             |      |
//  0  |  A2  |     B2      |      |
//     |______|______ ______|      |
//     |      |      |      |  D1  |
//  1  |  A3  |  B3  |  C2  |      |
//     |______|______|______|______|
//     |      |      |             |
//  2  |  A1  |  B1  |     C1      |
//     |______|______|______ ______|
//     |      |             |      |
//  3  |  A4  |     B4      |      |
//     |______|______ ______|      |
//     |      |      |      |  D2  |
//  4  |  A5  |  B5  |  C3  |      |
//     |______|______|______|______|
// ```
//
//  0: Automatically decide the best place to fit
// ```
//      ____________________________
//     |      |             |      |
//  0  |  A2  |     B2      |      |
//     |______|______ ______|      |
//     |      |      |      |  D1  |
//  1  |  A3  |  B3  |  C2  |      |
//     |______|______|______|______|
//     |      |             |      |
//  2  |  A4  |     B4      |      |
//     |______|______ ______|      |
//     |      |      |      |  D2  |
//  3  |  A5  |  B5  |  C3  |      |
//     |______|______|______|______|
//     |      |      |             |
//  4  |  A1  |  B1  |     C1      |
//     |______|______|______ ______|
// ```
//
//  1: Always put the origin after the target
// ```
//      ____________________________
//     |      |             |      |
//  0  |  A2  |     B2      |      |
//     |______|______ ______|      |
//     |      |      |      |  D1  |
//  1  |  A3  |  B3  |  C2  |      |
//     |______|______|______|______|
//     |      |             |      |
//  2  |  A4  |     B4      |      |
//     |______|______ ______|      |
//     |      |      |      |  D2  |
//  3  |  A5  |  B5  |  C3  |      |
//     |______|______|______|______|
//     |      |      |             |
//  4  |  A1  |  B1  |     C1      |
//     |______|______|______ ______|
// ```
//
// ```javascript
// dispatch(
//   moveRow(x, y, options)(state.tr)
// );
// ```
const moveRow = (originRowIndex, targetRowIndex, opts) => tr => {
  const defaultOptions = { tryToFit: false, direction: 0 };
  const options = Object.assign(defaultOptions, opts);
  const table = findTable(tr.selection);
  if (!table) {
    return tr;
  }

  const { indexes: indexesOriginRow } = getSelectionRangeInRow(originRowIndex)(
    tr
  );
  const { indexes: indexesTargetRow } = getSelectionRangeInRow(targetRowIndex)(
    tr
  );

  if (indexesOriginRow.indexOf(targetRowIndex) > -1) {
    return tr;
  }

  if (!options.tryToFit && indexesTargetRow.length > 1) {
    checkInvalidMovements(
      originRowIndex,
      targetRowIndex,
      indexesTargetRow,
      'row'
    );
  }

  const newTable = moveTableRow(
    table,
    indexesOriginRow,
    indexesTargetRow,
    options.direction
  );

  return cloneTr(tr).replaceWith(
    table.pos,
    table.pos + table.node.nodeSize,
    newTable
  );
};

// :: (originColumnIndex: number, targetColumnIndex: targetColumnIndex, options?: MovementOptions) → (tr: Transaction) → Transaction
// Returns a new transaction that moves the origin column to the target index;
//
// by default "tryToFit" is false, that means if you try to move a column to a place
// where we will need to split a column with merged cells it'll throw an exception, for example:
//
// ```
//    0      1         2
//  ____________________________
// |      |      |             |
// |  A1  |  B1  |     C1      |
// |______|______|______ ______|
// |      |             |      |
// |  A2  |     B2      |      |
// |______|______ ______|      |
// |      |      |      |  D1  |
// |  A3  |  B3  |  C2  |      |
// |______|______|______|______|
// ```
//
//
// if you try to move the column 0 to the column index 1 with tryToFit false,
// it'll throw an exception since you can't split the column 1;
// but if "tryToFit" is true, it'll move the column using the current direction.
//
// We defined current direction using the target and origin values
// if the origin is greater than the target, that means the course is `right-to-left`,
// so the `tryToFit` logic will use this direction to determine
// if we should move the column to the right or the left.
//
// for example, if you call the function using `moveColumn(0, 1, { tryToFit: true })`
// the result will be:
//
// ```
//    0       1             2
// _____________________ _______
// |      |             |      |
// |  B1  |     C1      |  A1  |
// |______|______ ______|______|
// |             |      |      |
// |     B2      |      |  A2  |
// |______ ______|      |______|
// |      |      |  D1  |      |
// |  B3  |  C2  |      |  A3  |
// |______|______|______|______|
// ```
//
// since we could put the column zero on index one,
// we pushed to the best place to fit the column 0, in this case, column index 2.
//
// -------- HOW TO OVERRIDE DIRECTION --------
//
// If you set "tryToFit" to "true", it will try to figure out the best direction
// place to fit using the origin and target index, for example:
//
//
// ```
//     0      1       2     3      4      5       6
//   _________________________________________________
//  |      |      |             |      |             |
//  |  A1  |  B1  |     C1      |  E1  |     F1      |
//  |______|______|______ ______|______|______ ______|
//  |      |             |      |             |      |
//  |  A2  |     B2      |      |     E2      |      |
//  |______|______ ______|      |______ ______|      |
//  |      |      |      |  D1  |      |      |  G2  |
//  |  A3  |  B3  |  C3  |      |  E3  |  F3  |      |
//  |______|______|______|______|______|______|______|
// ```
//
//
// If you try to move the column 0 to column index 5 with "tryToFit" enabled, by default,
// the code will put it on after the merged columns,
// but you can override it using the "direction" option.
//
// -1: Always put the origin before the target
//
// ```
//     0      1       2     3      4      5       6
//   _________________________________________________
//  |      |             |      |      |             |
//  |  B1  |     C1      |  A1  |  E1  |     F1      |
//  |______|______ ______|______|______|______ ______|
//  |             |      |      |             |      |
//  |     B2      |      |  A2  |     E2      |      |
//  |______ ______|      |______|______ ______|      |
//  |      |      |  D1  |      |      |      |  G2  |
//  |  B3  |  C3  |      |  A3  |  E3  |  F3  |      |
//  |______|______|______|______|______|______|______|
// ```
//
//  0: Automatically decide the best place to fit
//
// ```
//     0      1       2     3      4      5       6
//   _________________________________________________
//  |      |             |      |             |      |
//  |  B1  |     C1      |  E1  |     F1      |  A1  |
//  |______|______ ______|______|______ ______|______|
//  |             |      |             |      |      |
//  |     B2      |      |     E2      |      |  A2  |
//  |______ ______|      |______ ______|      |______|
//  |      |      |  D1  |      |      |  G2  |      |
//  |  B3  |  C3  |      |  E3  |  F3  |      |  A3  |
//  |______|______|______|______|______|______|______|
// ```
//
//  1: Always put the origin after the target
//
// ```
//     0      1       2     3      4      5       6
//   _________________________________________________
//  |      |             |      |             |      |
//  |  B1  |     C1      |  E1  |     F1      |  A1  |
//  |______|______ ______|______|______ ______|______|
//  |             |      |             |      |      |
//  |     B2      |      |     E2      |      |  A2  |
//  |______ ______|      |______ ______|      |______|
//  |      |      |  D1  |      |      |  G2  |      |
//  |  B3  |  C3  |      |  E3  |  F3  |      |  A3  |
//  |______|______|______|______|______|______|______|
// ```
//
// ```javascript
// dispatch(
//   moveColumn(x, y, options)(state.tr)
// );
// ```
const moveColumn = (originColumnIndex, targetColumnIndex, opts) => tr => {
  const defaultOptions = { tryToFit: false, direction: 0 };
  const options = Object.assign(defaultOptions, opts);
  const table = findTable(tr.selection);
  if (!table) {
    return tr;
  }

  const { indexes: indexesOriginColumn } = getSelectionRangeInColumn(
    originColumnIndex
  )(tr);
  const { indexes: indexesTargetColumn } = getSelectionRangeInColumn(
    targetColumnIndex
  )(tr);

  if (indexesOriginColumn.indexOf(targetColumnIndex) > -1) {
    return tr;
  }

  if (!options.tryToFit && indexesTargetColumn.length > 1) {
    checkInvalidMovements(
      originColumnIndex,
      targetColumnIndex,
      indexesTargetColumn,
      'column'
    );
  }

  const newTable = moveTableColumn(
    table,
    indexesOriginColumn,
    indexesTargetColumn,
    options.direction
  );

  return cloneTr(tr).replaceWith(
    table.pos,
    table.pos + table.node.nodeSize,
    newTable
  );
};

// :: (rowIndex: number, clonePreviousRow?: boolean) → (tr: Transaction) → Transaction
// Returns a new transaction that adds a new row at index `rowIndex`. Optionally clone the previous row.
//
// ```javascript
// dispatch(
//   addRowAt(i)(state.tr)
// );
// ```
//
// ```javascript
// dispatch(
//   addRowAt(i, true)(state.tr)
// );
// ```
const addRowAt = (rowIndex, clonePreviousRow) => tr => {
  const table = findTable(tr.selection);
  if (table) {
    const map = prosemirrorTables.TableMap.get(table.node);
    const cloneRowIndex = rowIndex - 1;

    if (clonePreviousRow && cloneRowIndex >= 0) {
      return cloneTr(cloneRowAt(cloneRowIndex)(tr));
    }

    if (rowIndex >= 0 && rowIndex <= map.height) {
      return cloneTr(
        prosemirrorTables.addRow(
          tr,
          {
            map,
            tableStart: table.start,
            table: table.node
          },
          rowIndex
        )
      );
    }
  }
  return tr;
};

// :: (cloneRowIndex: number) → (tr: Transaction) → Transaction
// Returns a new transaction that adds a new row after `cloneRowIndex`, cloning the row attributes at `cloneRowIndex`.
//
// ```javascript
// dispatch(
//   cloneRowAt(i)(state.tr)
// );
// ```
const cloneRowAt = rowIndex => tr => {
  const table = findTable(tr.selection);
  if (table) {
    const map = prosemirrorTables.TableMap.get(table.node);

    if (rowIndex >= 0 && rowIndex <= map.height) {
      const tableNode = table.node;
      const tableNodes = tableNodeTypes(tableNode.type.schema);

      let rowPos = table.start;
      for (let i = 0; i < rowIndex + 1; i++) {
        rowPos += tableNode.child(i).nodeSize;
      }

      const cloneRow = tableNode.child(rowIndex);
      // Re-create the same nodes with same attrs, dropping the node content.
      let cells = [];
      let rowWidth = 0;
      cloneRow.forEach(cell => {
        // If we're copying a row with rowspan somewhere, we dont want to copy that cell
        // We'll increment its span below.
        if (cell.attrs.rowspan === 1) {
          rowWidth += cell.attrs.colspan;
          cells.push(
            tableNodes[cell.type.spec.tableRole].createAndFill(
              cell.attrs,
              cell.marks
            )
          );
        }
      });

      // If a higher row spans past our clone row, bump the higher row to cover this new row too.
      if (rowWidth < map.width) {
        let rowSpanCells = [];
        for (let i = rowIndex; i >= 0; i--) {
          let foundCells = filterCellsInRow(i, (cell, tr) => {
            const rowspan = cell.node.attrs.rowspan;
            const spanRange = i + rowspan;
            return rowspan > 1 && spanRange > rowIndex;
          })(tr);
          rowSpanCells.push(...foundCells);
        }

        if (rowSpanCells.length) {
          rowSpanCells.forEach(cell => {
            tr = setCellAttrs(cell, {
              rowspan: cell.node.attrs.rowspan + 1
            })(tr);
          });
        }
      }

      return safeInsert(
        tableNodes.row.create(cloneRow.attrs, cells),
        rowPos
      )(tr);
    }
  }
  return tr;
};

// :: (columnIndex: number) → (tr: Transaction) → Transaction
// Returns a new transaction that removes a column at index `columnIndex`. If there is only one column left, it will remove the entire table.
//
// ```javascript
// dispatch(
//   removeColumnAt(i)(state.tr)
// );
// ```
const removeColumnAt = columnIndex => tr => {
  const table = findTable(tr.selection);
  if (table) {
    const map = prosemirrorTables.TableMap.get(table.node);
    if (columnIndex === 0 && map.width === 1) {
      return removeTable(tr);
    } else if (columnIndex >= 0 && columnIndex <= map.width) {
      prosemirrorTables.removeColumn(
        tr,
        {
          map,
          tableStart: table.start,
          table: table.node
        },
        columnIndex
      );
      return cloneTr(tr);
    }
  }
  return tr;
};

// :: (rowIndex: number) → (tr: Transaction) → Transaction
// Returns a new transaction that removes a row at index `rowIndex`. If there is only one row left, it will remove the entire table.
//
// ```javascript
// dispatch(
//   removeRowAt(i)(state.tr)
// );
// ```
const removeRowAt = rowIndex => tr => {
  const table = findTable(tr.selection);
  if (table) {
    const map = prosemirrorTables.TableMap.get(table.node);
    if (rowIndex === 0 && map.height === 1) {
      return removeTable(tr);
    } else if (rowIndex >= 0 && rowIndex <= map.height) {
      prosemirrorTables.removeRow(
        tr,
        {
          map,
          tableStart: table.start,
          table: table.node
        },
        rowIndex
      );
      return cloneTr(tr);
    }
  }
  return tr;
};

// :: (tr: Transaction) → Transaction
// Returns a new transaction that removes a table node if the cursor is inside of it.
//
// ```javascript
// dispatch(
//   removeTable(state.tr)
// );
// ```
const removeTable = tr => {
  const { $from } = tr.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    let node = $from.node(depth);
    if (node.type.spec.tableRole === 'table') {
      return cloneTr(tr.delete($from.before(depth), $from.after(depth)));
    }
  }
  return tr;
};

// :: (tr: Transaction) → Transaction
// Returns a new transaction that removes selected columns.
//
// ```javascript
// dispatch(
//   removeSelectedColumns(state.tr)
// );
// ```
const removeSelectedColumns = tr => {
  const { selection } = tr;
  if (isTableSelected(selection)) {
    return removeTable(tr);
  }
  if (isCellSelection(selection)) {
    const table = findTable(selection);
    if (table) {
      const map = prosemirrorTables.TableMap.get(table.node);
      const rect = map.rectBetween(
        selection.$anchorCell.pos - table.start,
        selection.$headCell.pos - table.start
      );

      if (rect.left == 0 && rect.right == map.width) {
        return false;
      }

      const pmTableRect = Object.assign({}, rect, {
        map,
        table: table.node,
        tableStart: table.start
      });

      for (let i = pmTableRect.right - 1; ; i--) {
        prosemirrorTables.removeColumn(tr, pmTableRect, i);
        if (i === pmTableRect.left) {
          break;
        }
        pmTableRect.table = pmTableRect.tableStart
          ? tr.doc.nodeAt(pmTableRect.tableStart - 1)
          : tr.doc;
        pmTableRect.map = prosemirrorTables.TableMap.get(pmTableRect.table);
      }
      return cloneTr(tr);
    }
  }
  return tr;
};

// :: (tr: Transaction) → Transaction
// Returns a new transaction that removes selected rows.
//
// ```javascript
// dispatch(
//   removeSelectedRows(state.tr)
// );
// ```
const removeSelectedRows = tr => {
  const { selection } = tr;
  if (isTableSelected(selection)) {
    return removeTable(tr);
  }
  if (isCellSelection(selection)) {
    const table = findTable(selection);
    if (table) {
      const map = prosemirrorTables.TableMap.get(table.node);
      const rect = map.rectBetween(
        selection.$anchorCell.pos - table.start,
        selection.$headCell.pos - table.start
      );

      if (rect.top == 0 && rect.bottom == map.height) {
        return false;
      }

      const pmTableRect = Object.assign({}, rect, {
        map,
        table: table.node,
        tableStart: table.start
      });

      for (let i = pmTableRect.bottom - 1; ; i--) {
        prosemirrorTables.removeRow(tr, pmTableRect, i);
        if (i === pmTableRect.top) {
          break;
        }
        pmTableRect.table = pmTableRect.tableStart
          ? tr.doc.nodeAt(pmTableRect.tableStart - 1)
          : tr.doc;
        pmTableRect.map = prosemirrorTables.TableMap.get(pmTableRect.table);
      }

      return cloneTr(tr);
    }
  }
  return tr;
};

// :: ($pos: ResolvedPos) → (tr: Transaction) → Transaction
// Returns a new transaction that removes a column closest to a given `$pos`.
//
// ```javascript
// dispatch(
//   removeColumnClosestToPos(state.doc.resolve(3))(state.tr)
// );
// ```
const removeColumnClosestToPos = $pos => tr => {
  const rect = findCellRectClosestToPos($pos);
  if (rect) {
    return removeColumnAt(rect.left)(setTextSelection($pos.pos)(tr));
  }
  return tr;
};

// :: ($pos: ResolvedPos) → (tr: Transaction) → Transaction
// Returns a new transaction that removes a row closest to a given `$pos`.
//
// ```javascript
// dispatch(
//   removeRowClosestToPos(state.doc.resolve(3))(state.tr)
// );
// ```
const removeRowClosestToPos = $pos => tr => {
  const rect = findCellRectClosestToPos($pos);
  if (rect) {
    return removeRowAt(rect.top)(setTextSelection($pos.pos)(tr));
  }
  return tr;
};

// :: (columnIndex: number, cellTransform: (cell: {pos: number, start: number, node: ProseMirrorNode}, tr: Transaction) → Transaction, setCursorToLastCell: ?boolean) → (tr: Transaction) → Transaction
// Returns a new transaction that maps a given `cellTransform` function to each cell in a column at a given `columnIndex`.
// It will set the selection into the last cell of the column if `setCursorToLastCell` param is set to `true`.
//
// ```javascript
// dispatch(
//   forEachCellInColumn(0, (cell, tr) => emptyCell(cell, state.schema)(tr))(state.tr)
// );
// ```
const forEachCellInColumn = (
  columnIndex,
  cellTransform,
  setCursorToLastCell
) => tr => {
  const cells = getCellsInColumn(columnIndex)(tr.selection);
  if (cells) {
    for (let i = cells.length - 1; i >= 0; i--) {
      tr = cellTransform(cells[i], tr);
    }
    if (setCursorToLastCell) {
      const $pos = tr.doc.resolve(tr.mapping.map(cells[cells.length - 1].pos));
      tr.setSelection(prosemirrorState.Selection.near($pos));
    }
    return cloneTr(tr);
  }
  return tr;
};

// :: (rowIndex: number, cellTransform: (cell: {pos: number, start: number, node: ProseMirrorNode}, tr: Transaction) → Transaction, setCursorToLastCell: ?boolean) → (tr: Transaction) → Transaction
// Returns a new transaction that maps a given `cellTransform` function to each cell in a row at a given `rowIndex`.
// It will set the selection into the last cell of the row if `setCursorToLastCell` param is set to `true`.
//
// ```javascript
// dispatch(
//   forEachCellInRow(0, (cell, tr) => setCellAttrs(cell, { background: 'red' })(tr))(state.tr)
// );
// ```
const forEachCellInRow = (
  rowIndex,
  cellTransform,
  setCursorToLastCell
) => tr => {
  const cells = getCellsInRow(rowIndex)(tr.selection);
  if (cells) {
    for (let i = cells.length - 1; i >= 0; i--) {
      tr = cellTransform(cells[i], tr);
    }
    if (setCursorToLastCell) {
      const $pos = tr.doc.resolve(tr.mapping.map(cells[cells.length - 1].pos));
      tr.setSelection(prosemirrorState.Selection.near($pos));
    }
  }
  return tr;
};

// :: (cell: {pos: number, start: number, node: ProseMirrorNode}, attrs: Object) → (tr: Transaction) → Transaction
// Returns a new transaction that sets given `attrs` to a given `cell`.
//
// ```javascript
// dispatch(
//   setCellAttrs(findCellClosestToPos($pos), { background: 'blue' })(tr);
// );
// ```
const setCellAttrs = (cell, attrs) => tr => {
  if (cell) {
    tr.setNodeMarkup(cell.pos, null, Object.assign({}, cell.node.attrs, attrs));
    return cloneTr(tr);
  }
  return tr;
};

// :: (schema: Schema, rowsCount: ?number, colsCount: ?number, withHeaderRow: ?boolean, cellContent: ?Node) → Node
// Returns a table node of a given size.
// `withHeaderRow` defines whether the first row of the table will be a header row.
// `cellContent` defines the content of each cell.
//
// ```javascript
// const table = createTable(state.schema); // 3x3 table node
// dispatch(
//   tr.replaceSelectionWith(table).scrollIntoView()
// );
// ```
const createTable = (
  schema,
  rowsCount = 3,
  colsCount = 3,
  withHeaderRow = true,
  cellContent = null
) => {
  const {
    cell: tableCell,
    header_cell: tableHeader,
    row: tableRow,
    table
  } = tableNodeTypes(schema);

  const cells = [];
  const headerCells = [];
  for (let i = 0; i < colsCount; i++) {
    cells.push(createCell(tableCell, cellContent));

    if (withHeaderRow) {
      headerCells.push(createCell(tableHeader, cellContent));
    }
  }

  const rows = [];
  for (let i = 0; i < rowsCount; i++) {
    rows.push(
      tableRow.createChecked(
        null,
        withHeaderRow && i === 0 ? headerCells : cells
      )
    );
  }

  return table.createChecked(null, rows);
};

// :: ($pos: ResolvedPos) → ?{pos: number, start: number, node: ProseMirrorNode}
// Iterates over parent nodes, returning a table cell or a table header node closest to a given `$pos`.
//
// ```javascript
// const cell = findCellClosestToPos(state.selection.$from);
// ```
const findCellClosestToPos = $pos => {
  const predicate = node =>
    node.type.spec.tableRole && /cell/i.test(node.type.spec.tableRole);
  return findParentNodeClosestToPos($pos, predicate);
};

// :: ($pos: ResolvedPos) → ?{left: number, top: number, right: number, bottom: number}
// Returns the rectangle spanning a cell closest to a given `$pos`.
//
// ```javascript
// dispatch(
//   findCellRectClosestToPos(state.selection.$from)
// );
// ```
const findCellRectClosestToPos = $pos => {
  const cell = findCellClosestToPos($pos);
  if (cell) {
    const table = findTableClosestToPos($pos);
    const map = prosemirrorTables.TableMap.get(table.node);
    const cellPos = cell.pos - table.start;
    return map.rectBetween(cellPos, cellPos);
  }
};

const filterCellsInRow = (rowIndex, predicate) => tr => {
  let foundCells = [];
  const cells = getCellsInRow(rowIndex)(tr.selection);
  if (cells) {
    for (let j = cells.length - 1; j >= 0; j--) {
      if (predicate(cells[j], tr)) {
        foundCells.push(cells[j]);
      }
    }
  }

  return foundCells;
};

// :: (columnIndex: number) → (tr: Transaction) → {$anchor: ResolvedPos, $head: ResolvedPos, indexes: [number]}
// Returns a range of rectangular selection spanning all merged cells around a column at index `columnIndex`.
//
// ```javascript
// const range = getSelectionRangeInColumn(3)(state.tr);
// ```
const getSelectionRangeInColumn = columnIndex => tr => {
  let startIndex = columnIndex;
  let endIndex = columnIndex;

  // looking for selection start column (startIndex)
  for (let i = columnIndex; i >= 0; i--) {
    const cells = getCellsInColumn(i)(tr.selection);
    if (cells) {
      cells.forEach(cell => {
        let maybeEndIndex = cell.node.attrs.colspan + i - 1;
        if (maybeEndIndex >= startIndex) {
          startIndex = i;
        }
        if (maybeEndIndex > endIndex) {
          endIndex = maybeEndIndex;
        }
      });
    }
  }
  // looking for selection end column (endIndex)
  for (let i = columnIndex; i <= endIndex; i++) {
    const cells = getCellsInColumn(i)(tr.selection);
    if (cells) {
      cells.forEach(cell => {
        let maybeEndIndex = cell.node.attrs.colspan + i - 1;
        if (cell.node.attrs.colspan > 1 && maybeEndIndex > endIndex) {
          endIndex = maybeEndIndex;
        }
      });
    }
  }

  // filter out columns without cells (where all rows have colspan > 1 in the same column)
  const indexes = [];
  for (let i = startIndex; i <= endIndex; i++) {
    const maybeCells = getCellsInColumn(i)(tr.selection);
    if (maybeCells && maybeCells.length) {
      indexes.push(i);
    }
  }
  startIndex = indexes[0];
  endIndex = indexes[indexes.length - 1];

  const firstSelectedColumnCells = getCellsInColumn(startIndex)(tr.selection);
  const firstRowCells = getCellsInRow(0)(tr.selection);
  const $anchor = tr.doc.resolve(
    firstSelectedColumnCells[firstSelectedColumnCells.length - 1].pos
  );

  let headCell;
  for (let i = endIndex; i >= startIndex; i--) {
    const columnCells = getCellsInColumn(i)(tr.selection);
    if (columnCells && columnCells.length) {
      for (let j = firstRowCells.length - 1; j >= 0; j--) {
        if (firstRowCells[j].pos === columnCells[0].pos) {
          headCell = columnCells[0];
          break;
        }
      }
      if (headCell) {
        break;
      }
    }
  }

  const $head = tr.doc.resolve(headCell.pos);
  return { $anchor, $head, indexes };
};

// :: (rowIndex: number) → (tr: Transaction) → {$anchor: ResolvedPos, $head: ResolvedPos, indexes: [number]}
// Returns a range of rectangular selection spanning all merged cells around a row at index `rowIndex`.
//
// ```javascript
// const range = getSelectionRangeInRow(3)(state.tr);
// ```
const getSelectionRangeInRow = rowIndex => tr => {
  let startIndex = rowIndex;
  let endIndex = rowIndex;
  // looking for selection start row (startIndex)
  for (let i = rowIndex; i >= 0; i--) {
    const cells = getCellsInRow(i)(tr.selection);
    cells.forEach(cell => {
      let maybeEndIndex = cell.node.attrs.rowspan + i - 1;
      if (maybeEndIndex >= startIndex) {
        startIndex = i;
      }
      if (maybeEndIndex > endIndex) {
        endIndex = maybeEndIndex;
      }
    });
  }
  // looking for selection end row (endIndex)
  for (let i = rowIndex; i <= endIndex; i++) {
    const cells = getCellsInRow(i)(tr.selection);
    cells.forEach(cell => {
      let maybeEndIndex = cell.node.attrs.rowspan + i - 1;
      if (cell.node.attrs.rowspan > 1 && maybeEndIndex > endIndex) {
        endIndex = maybeEndIndex;
      }
    });
  }

  // filter out rows without cells (where all columns have rowspan > 1 in the same row)
  const indexes = [];
  for (let i = startIndex; i <= endIndex; i++) {
    const maybeCells = getCellsInRow(i)(tr.selection);
    if (maybeCells && maybeCells.length) {
      indexes.push(i);
    }
  }
  startIndex = indexes[0];
  endIndex = indexes[indexes.length - 1];

  const firstSelectedRowCells = getCellsInRow(startIndex)(tr.selection);
  const firstColumnCells = getCellsInColumn(0)(tr.selection);
  const $anchor = tr.doc.resolve(
    firstSelectedRowCells[firstSelectedRowCells.length - 1].pos
  );

  let headCell;
  for (let i = endIndex; i >= startIndex; i--) {
    const rowCells = getCellsInRow(i)(tr.selection);
    if (rowCells && rowCells.length) {
      for (let j = firstColumnCells.length - 1; j >= 0; j--) {
        if (firstColumnCells[j].pos === rowCells[0].pos) {
          headCell = rowCells[0];
          break;
        }
      }
      if (headCell) {
        break;
      }
    }
  }

  const $head = tr.doc.resolve(headCell.pos);
  return { $anchor, $head, indexes };
};

exports.addColumnAt = addColumnAt;
exports.addRowAt = addRowAt;
exports.canInsert = canInsert;
exports.cloneRowAt = cloneRowAt;
exports.contains = contains;
exports.convertArrayOfRowsToTableNode = convertArrayOfRowsToTableNode;
exports.convertTableNodeToArrayOfRows = convertTableNodeToArrayOfRows;
exports.createTable = createTable;
exports.emptyCell = emptyCell;
exports.findBlockNodes = findBlockNodes;
exports.findCellClosestToPos = findCellClosestToPos;
exports.findCellRectClosestToPos = findCellRectClosestToPos;
exports.findChildren = findChildren;
exports.findChildrenByAttr = findChildrenByAttr;
exports.findChildrenByMark = findChildrenByMark;
exports.findChildrenByType = findChildrenByType;
exports.findDomRefAtPos = findDomRefAtPos;
exports.findInlineNodes = findInlineNodes;
exports.findParentDomRef = findParentDomRef;
exports.findParentDomRefOfType = findParentDomRefOfType;
exports.findParentNode = findParentNode;
exports.findParentNodeClosestToPos = findParentNodeClosestToPos;
exports.findParentNodeOfType = findParentNodeOfType;
exports.findParentNodeOfTypeClosestToPos = findParentNodeOfTypeClosestToPos;
exports.findPositionOfNodeBefore = findPositionOfNodeBefore;
exports.findSelectedNodeOfType = findSelectedNodeOfType;
exports.findTable = findTable;
exports.findTextNodes = findTextNodes;
exports.flatten = flatten;
exports.forEachCellInColumn = forEachCellInColumn;
exports.forEachCellInRow = forEachCellInRow;
exports.getCellsInColumn = getCellsInColumn;
exports.getCellsInRow = getCellsInRow;
exports.getCellsInTable = getCellsInTable;
exports.getSelectionRangeInColumn = getSelectionRangeInColumn;
exports.getSelectionRangeInRow = getSelectionRangeInRow;
exports.getSelectionRect = getSelectionRect;
exports.hasParentNode = hasParentNode;
exports.hasParentNodeOfType = hasParentNodeOfType;
exports.isCellSelection = isCellSelection;
exports.isColumnSelected = isColumnSelected;
exports.isNodeSelection = isNodeSelection;
exports.isRowSelected = isRowSelected;
exports.isTableSelected = isTableSelected;
exports.moveColumn = moveColumn;
exports.moveRow = moveRow;
exports.removeColumnAt = removeColumnAt;
exports.removeColumnClosestToPos = removeColumnClosestToPos;
exports.removeNodeBefore = removeNodeBefore;
exports.removeParentNodeOfType = removeParentNodeOfType;
exports.removeRowAt = removeRowAt;
exports.removeRowClosestToPos = removeRowClosestToPos;
exports.removeSelectedColumns = removeSelectedColumns;
exports.removeSelectedNode = removeSelectedNode;
exports.removeSelectedRows = removeSelectedRows;
exports.removeTable = removeTable;
exports.replaceParentNodeOfType = replaceParentNodeOfType;
exports.replaceSelectedNode = replaceSelectedNode;
exports.safeInsert = safeInsert;
exports.selectColumn = selectColumn;
exports.selectParentNodeOfType = selectParentNodeOfType;
exports.selectRow = selectRow;
exports.selectTable = selectTable;
exports.setCellAttrs = setCellAttrs;
exports.setParentNodeMarkup = setParentNodeMarkup;
exports.setTextSelection = setTextSelection;
//# sourceMappingURL=index.js.map
