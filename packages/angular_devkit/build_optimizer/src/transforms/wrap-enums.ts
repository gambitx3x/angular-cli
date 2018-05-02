/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import * as ts from 'typescript';
import { drilldownNodes } from '../helpers/ast-utils';


export function testWrapEnums(content: string) {
  const ts22EnumVarDecl = /var (\S+) = \{\};/;
  // tslint:disable-next-line:max-line-length
  const ts22EnumIife = /(\1\.(\S+) = \d+;\r?\n)+\1\[\1\.(\S+)\] = "\4";\r?\n(\1\[\1\.(\S+)\] = "\S+";\r?\n*)+/;
  const ts23To26VarDecl = /var (\S+);(\/\*@__PURE__\*\/)*/;
  // tslint:disable-next-line:max-line-length
  const ts23To26Iife = /\(function \(\1\) \{\s+(\1\[\1\["(\S+)"\] = (\S+)\] = "\4";(\s+\1\[\1\["\S+"\] = (\S+)\] = "\S+";)*\r?\n)\}\)\(\1 \|\| \(\1 = \{\}\)\);/;
  const enumComment = /\/\*\* @enum \{\w+\} \*\//;
  const multiLineComment = /\s*(?:\/\*[\s\S]*?\*\/)?\s*/;
  const newLine = /\s*\r?\n\s*/;

  const regexes = [
    [
      ts22EnumVarDecl,
      newLine, multiLineComment,
      ts22EnumIife,
    ],
    [
      ts23To26VarDecl,
      newLine, multiLineComment,
      ts23To26Iife,
    ],
    [enumComment],
  ].map(arr => new RegExp(arr.map(x => x.source).join(''), 'm'));

  return regexes.some((regex) => regex.test(content));
}

function isBlockLike(node: ts.Node): node is ts.BlockLike {
  return node.kind === ts.SyntaxKind.Block
      || node.kind === ts.SyntaxKind.ModuleBlock
      || node.kind === ts.SyntaxKind.CaseClause
      || node.kind === ts.SyntaxKind.DefaultClause
      || node.kind === ts.SyntaxKind.SourceFile;
}

export function getWrapEnumsTransformer(): ts.TransformerFactory<ts.SourceFile> {
  return (context: ts.TransformationContext): ts.Transformer<ts.SourceFile> => {
    const transformer: ts.Transformer<ts.SourceFile> = (sf: ts.SourceFile) => {

      const result = visitBlockStatements(sf.statements, context);

      return ts.updateSourceFileNode(sf, ts.setTextRange(result, sf.statements));
    };

    return transformer;
  };
}

function visitBlockStatements(
  statements: ts.NodeArray<ts.Statement>,
  context: ts.TransformationContext,
): ts.NodeArray<ts.Statement> {

  // copy of statements to modify; lazy initialized
  let updatedStatements: Array<ts.Statement> | undefined;

  const visitor: ts.Visitor = (node) => {
    if (isBlockLike(node)) {
      let result = visitBlockStatements(node.statements, context);
      if (result === node.statements) {
        return node;
      }
      result = ts.setTextRange(result, node.statements);
      switch (node.kind) {
        case ts.SyntaxKind.Block:
          return ts.updateBlock(node as ts.Block, result);
        case ts.SyntaxKind.ModuleBlock:
          return ts.updateModuleBlock(node as ts.ModuleBlock, result);
        case ts.SyntaxKind.CaseClause:
          const clause = node as ts.CaseClause;

          return ts.updateCaseClause(clause, clause.expression, result);
        case ts.SyntaxKind.DefaultClause:
          return ts.updateDefaultClause(node as ts.DefaultClause, result);
        default:
          return node;
      }
    } else {
      return ts.visitEachChild(node, visitor, context);
    }
  };

  // 'oIndex' is the original statement index; 'uIndex' is the updated statement index
  for (let oIndex = 0, uIndex = 0; oIndex < statements.length; oIndex++, uIndex++) {
    const currentStatement = statements[oIndex];

    // these can't contain an enum declaration
    if (currentStatement.kind === ts.SyntaxKind.ImportDeclaration) {
      continue;
    }

    // enum declarations must:
    //   * not be last statement
    //   * be a variable statement
    //   * have only one declaration
    //   * have an identifer as a declaration name
    if (oIndex < statements.length - 1
        && ts.isVariableStatement(currentStatement)
        && currentStatement.declarationList.declarations.length === 1) {

      const variableDeclaration = currentStatement.declarationList.declarations[0];
      if (ts.isIdentifier(variableDeclaration.name)) {
        const name = variableDeclaration.name.text;

        if (!variableDeclaration.initializer) {
          const iife = findTs2_3EnumIife(name, statements[oIndex + 1]);
          if (iife) {
            // found an enum
            if (!updatedStatements) {
              updatedStatements = statements.slice();
            }
            // update IIFE and replace variable statement and old IIFE
            updatedStatements.splice(uIndex, 2, updateEnumIife(
              currentStatement,
              iife,
            ));
            // skip IIFE statement
            oIndex++;
            continue;
          }
        } else if (ts.isObjectLiteralExpression(variableDeclaration.initializer)
                   && variableDeclaration.initializer.properties.length === 0) {
          const enumStatements = findTs2_2EnumStatements(name, statements, oIndex + 1);
          if (enumStatements.length > 0) {
            // found an enum
            if (!updatedStatements) {
              updatedStatements = statements.slice();
            }
            // create wrapper and replace variable statement and enum member statements
            updatedStatements.splice(uIndex, enumStatements.length + 1, createWrappedEnum(
              name,
              currentStatement,
              enumStatements,
              variableDeclaration.initializer,
            ));
            // skip enum member declarations
            oIndex += enumStatements.length;
            continue;
          }
        } else if (ts.isObjectLiteralExpression(variableDeclaration.initializer)
          && variableDeclaration.initializer.properties.length !== 0) {
          const literalPropertyCount = variableDeclaration.initializer.properties.length;
          const enumStatements = findTsickleEnumStatements(name, statements, oIndex + 1);
          if (enumStatements.length === literalPropertyCount) {
            // found an enum
            if (!updatedStatements) {
              updatedStatements = statements.slice();
            }
            // create wrapper and replace variable statement and enum member statements
            updatedStatements.splice(uIndex, enumStatements.length + 1, createWrappedEnum(
              name,
              currentStatement,
              enumStatements,
              variableDeclaration.initializer,
            ));
            // skip enum member declarations
            oIndex += enumStatements.length;
            continue;
          }
        }
      }
    }

    const result = ts.visitNode(currentStatement, visitor);
    if (result !== currentStatement) {
      if (!updatedStatements) {
        updatedStatements = statements.slice();
      }
      updatedStatements[uIndex] = result;
    }
  }

  // if changes, return updated statements
  // otherwise, return original array instance
  return updatedStatements ? ts.createNodeArray(updatedStatements) : statements;
}

// TS 2.3 enums have statements that are inside a IIFE.
function findTs2_3EnumIife(name: string, statement: ts.Statement): ts.CallExpression | null {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
    return null;
  }

  const funcExpr = drilldownNodes<ts.FunctionExpression>(statement,
    [
      { prop: null, kind: ts.SyntaxKind.ExpressionStatement },
      { prop: 'expression', kind: ts.SyntaxKind.CallExpression },
      { prop: 'expression', kind: ts.SyntaxKind.ParenthesizedExpression },
      { prop: 'expression', kind: ts.SyntaxKind.FunctionExpression },
    ]);

  if (funcExpr === null) { return null; }

  if (!(
    funcExpr.parameters.length === 1
    && funcExpr.parameters[0].name.kind === ts.SyntaxKind.Identifier
    && (funcExpr.parameters[0].name as ts.Identifier).text === name
  )) {
    return null;
  }

  // In TS 2.3 enums, the IIFE contains only expressions with a certain format.
  // If we find any that is different, we ignore the whole thing.
  for (const innerStmt of funcExpr.body.statements) {

    const innerBinExpr = drilldownNodes<ts.BinaryExpression>(innerStmt,
      [
        { prop: null, kind: ts.SyntaxKind.ExpressionStatement },
        { prop: 'expression', kind: ts.SyntaxKind.BinaryExpression },
      ]);

    if (innerBinExpr === null) { return null; }

    if (!(innerBinExpr.operatorToken.kind === ts.SyntaxKind.FirstAssignment
        && innerBinExpr.left.kind === ts.SyntaxKind.ElementAccessExpression)) {
      return null;
    }

    const innerElemAcc = innerBinExpr.left as ts.ElementAccessExpression;

    if (!(
      innerElemAcc.expression.kind === ts.SyntaxKind.Identifier
      && (innerElemAcc.expression as ts.Identifier).text === name
      && innerElemAcc.argumentExpression
      && innerElemAcc.argumentExpression.kind === ts.SyntaxKind.BinaryExpression
    )) {
      return null;
    }

    const innerArgBinExpr = innerElemAcc.argumentExpression as ts.BinaryExpression;

    if (innerArgBinExpr.left.kind !== ts.SyntaxKind.ElementAccessExpression) {
      return null;
    }

    const innerArgElemAcc = innerArgBinExpr.left as ts.ElementAccessExpression;

    if (!(
      innerArgElemAcc.expression.kind === ts.SyntaxKind.Identifier
      && (innerArgElemAcc.expression as ts.Identifier).text === name
    )) {
      return null;
    }
  }

  return statement.expression;
}

// TS 2.2 enums have statements after the variable declaration, with index statements followed
// by value statements.
function findTs2_2EnumStatements(
  name: string,
  statements: ts.NodeArray<ts.Statement>,
  statementOffset: number,
): ts.ExpressionStatement[] {
  const enumStatements: ts.ExpressionStatement[] = [];
  let beforeValueStatements = true;

  for (let index = statementOffset; index < statements.length; index++) {
    // Ensure all statements are of the expected format and using the right identifer.
    // When we find a statement that isn't part of the enum, return what we collected so far.
    const binExpr = drilldownNodes<ts.BinaryExpression>(statements[index],
      [
        { prop: null, kind: ts.SyntaxKind.ExpressionStatement },
        { prop: 'expression', kind: ts.SyntaxKind.BinaryExpression },
      ]);

    if (binExpr === null
      || (binExpr.left.kind !== ts.SyntaxKind.PropertyAccessExpression
        && binExpr.left.kind !== ts.SyntaxKind.ElementAccessExpression)
    ) {
      return beforeValueStatements ? [] : enumStatements;
    }

    const exprStmt = statements[index] as ts.ExpressionStatement;
    const leftExpr = binExpr.left as ts.PropertyAccessExpression | ts.ElementAccessExpression;

    if (!(leftExpr.expression.kind === ts.SyntaxKind.Identifier
        && (leftExpr.expression as ts.Identifier).text === name)) {
      return beforeValueStatements ? [] : enumStatements;
    }

    if (!beforeValueStatements && leftExpr.kind === ts.SyntaxKind.PropertyAccessExpression) {
      // We shouldn't find index statements after value statements.
      return [];
    } else if (beforeValueStatements && leftExpr.kind === ts.SyntaxKind.ElementAccessExpression) {
      beforeValueStatements = false;
    }

    enumStatements.push(exprStmt);
  }

  return enumStatements;
}

// Tsickle enums have a variable statement with indexes, followed by value statements.
// See https://github.com/angular/devkit/issues/229#issuecomment-338512056 fore more information.
function findTsickleEnumStatements(
  name: string,
  statements: ts.NodeArray<ts.Statement>,
  statementOffset: number,
): ts.Statement[] {
  const enumStatements: ts.Statement[] = [];

  for (let index = statementOffset; index < statements.length; index++) {
    // Ensure all statements are of the expected format and using the right identifer.
    // When we find a statement that isn't part of the enum, return what we collected so far.
    const access = drilldownNodes<ts.ElementAccessExpression>(statements[index],
      [
        { prop: null, kind: ts.SyntaxKind.ExpressionStatement },
        { prop: 'expression', kind: ts.SyntaxKind.BinaryExpression },
        { prop: 'left', kind: ts.SyntaxKind.ElementAccessExpression },
      ]);

    if (!access) {
      break;
    }

    if (!ts.isIdentifier(access.expression) || access.expression.text !== name) {
      break;
    }

    if (!access.argumentExpression || !ts.isPropertyAccessExpression(access.argumentExpression)) {
      break;
    }

    const enumExpression = access.argumentExpression.expression;
    if (!ts.isIdentifier(enumExpression) || enumExpression.text !== name) {
      break;
    }

    enumStatements.push(statements[index]);
  }

  return enumStatements;
}

function updateHostNode(hostNode: ts.VariableStatement, expression: ts.Expression): ts.Statement {
  const pureFunctionComment = '@__PURE__';

  // Update existing host node with the pure comment before the variable declaration initializer.
  const variableDeclaration = hostNode.declarationList.declarations[0];
  const outerVarStmt = ts.updateVariableStatement(
    hostNode,
    hostNode.modifiers,
    ts.updateVariableDeclarationList(
      hostNode.declarationList,
      [
        ts.updateVariableDeclaration(
          variableDeclaration,
          variableDeclaration.name,
          variableDeclaration.type,
          ts.addSyntheticLeadingComment(
            expression,
            ts.SyntaxKind.MultiLineCommentTrivia,
            pureFunctionComment,
            false,
          ),
        ),
      ],
    ),
  );

  return outerVarStmt;
}

function updateEnumIife(hostNode: ts.VariableStatement, iife: ts.CallExpression): ts.Statement {
  if (!ts.isParenthesizedExpression(iife.expression)
      || !ts.isFunctionExpression(iife.expression.expression)) {
    throw new Error('Invalid IIFE Structure');
  }

  const expression = iife.expression.expression;
  const updatedFunction = ts.updateFunctionExpression(
    expression,
    expression.modifiers,
    expression.asteriskToken,
    expression.name,
    expression.typeParameters,
    expression.parameters,
    expression.type,
    ts.updateBlock(
      expression.body,
      [
        ...expression.body.statements,
        ts.createReturn(expression.parameters[0].name as ts.Identifier),
      ],
    ),
  );

  const updatedIife = ts.updateCall(
    iife,
    ts.updateParen(
      iife.expression,
      updatedFunction,
    ),
    iife.typeArguments,
    [ts.createObjectLiteral()],
  );

  return updateHostNode(hostNode, updatedIife);
}

function createWrappedEnum(
  name: string,
  hostNode: ts.VariableStatement,
  statements: Array<ts.Statement>,
  literalInitializer: ts.ObjectLiteralExpression | undefined,
): ts.Statement {
  literalInitializer = literalInitializer || ts.createObjectLiteral();
  const innerVarStmt = ts.createVariableStatement(
    undefined,
    ts.createVariableDeclarationList([
      ts.createVariableDeclaration(name, undefined, literalInitializer),
    ]),
  );

  const innerReturn = ts.createReturn(ts.createIdentifier(name));

  const iife = ts.createImmediatelyInvokedFunctionExpression([
    innerVarStmt,
    ...statements,
    innerReturn,
  ]);

  return updateHostNode(hostNode, ts.createParen(iife));
}
