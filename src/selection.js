import { equalNodeType } from "./helpers";

// :: (predicate: (node: ProseMirrorNode) → boolean) → (selection: Selection) → ?{pos: number, node: ProseMirrorNode}
// Iterates over parent nodes, returning the first node and its position `predicate` returns truthy for.
export const findParentNode = predicate => selection => {
  const { $from } = selection;
  for (let i = $from.depth; i > 0; i--) {
    const node = $from.node(i);
    if (predicate(node)) {
      return {
        pos: $from.start(i),
        node
      };
    }
  }
};

// :: (predicate: (node: ProseMirrorNode) → boolean, domAtPos: (pos: number) → {node: dom.Node, offset: number}) → (selection: Selection) → ?dom.Node
// Iterates over parent nodes, returning DOM reference of the first node `predicate` returns truthy for.
export const findParentDomRef = (predicate, domAtPos) => selection => {
  const parent = findParentNode(predicate)(selection);
  if (parent) {
    return domAtPos(parent.pos).node;
  }
};

// :: (predicate: (node: ProseMirrorNode) → boolean) → (selection: Selection) → boolean
// Checks if there's a parent node `predicate` returns truthy for.
export const hasParentNode = predicate => selection => {
  return !!findParentNode(predicate)(selection);
};

// :: (nodeType: union<NodeType, [NodeType]>) → (selection: Selection) → ?{node: ProseMirrorNode, pos: number}
// Iterates over parent nodes, returning first node of the given `nodeType`.
export const findParentNodeOfType = nodeType => selection => {
  return findParentNode(node => equalNodeType(nodeType, node))(selection);
};

// :: (nodeType: union<NodeType, [NodeType]>) → (selection: Selection) → boolean
// Checks if there's a parent node of the given `nodeType`.
export const hasParentNodeOfType = nodeType => selection => {
  return hasParentNode(node => equalNodeType(nodeType, node))(selection);
};

// :: (nodeType: union<NodeType, [NodeType]>, domAtPos: (pos: number) → {node: dom.Node, offset: number}) → (selection: Selection) → ?dom.Node
// Iterates over parent nodes, returning DOM reference of the first node of the given `nodeType`.
export const findParentDomRefOfType = (nodeType, domAtPos) => selection => {
  return findParentDomRef(node => equalNodeType(nodeType, node), domAtPos)(
    selection
  );
};

// :: (nodeType: union<NodeType, [NodeType]>) → (selection: Selection) → ?ProseMirrorNode
// Returns a node of a given `nodeType` if its selected.
export const findSelectedNodeOfType = nodeType => selection => {
  if (selection.node) {
    const { node } = selection;
    if (equalNodeType(nodeType, node)) {
      return node;
    }
  }
};
