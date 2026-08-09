const INSTRUCTION = [
  "convert each instance to strongly typed domain types that have been parsed at the",
  "earliest time possible and as close to the io boundary the data originated from",
].join(" ");

function isRecordStringUnknown(node) {
  const parameters = node.typeParameters?.params ?? node.typeArguments?.params ?? [];

  return (
    node.typeName?.type === "Identifier" &&
    node.typeName.name === "Record" &&
    parameters.length === 2 &&
    parameters[0]?.type === "TSStringKeyword" &&
    parameters[1]?.type === "TSUnknownKeyword"
  );
}

const noRecordUnknown = {
  meta: {
    type: "problem",
    docs: {
      description: "Reject Record<string, unknown> in favor of parsed domain types.",
    },
    schema: [],
  },
  create(context) {
    return {
      TSTypeReference(node) {
        if (isRecordStringUnknown(node)) {
          context.report({ node, message: INSTRUCTION });
        }
      },
    };
  },
};

export default {
  meta: {
    name: "agent-customization",
  },
  rules: {
    "no-record-unknown": noRecordUnknown,
  },
};
