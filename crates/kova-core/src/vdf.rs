//! Hand-rolled parser for Valve's KeyValues text format (VDF / ACF).
//!
//! The format is a sequence of key-value pairs. A value is either a quoted
//! (or bare) string, or a nested object in braces:
//!
//! ```text
//! "AppState"
//! {
//!     "appid"     "730"
//!     // this is a comment
//!     "name"      "Counter-Strike 2"
//! }
//! ```
//!
//! Keys are matched case-insensitively, mirroring Valve's own parser.

use std::fmt;

/// A parsed KeyValues node: either a scalar string or an object made of
/// ordered key-value pairs (duplicate keys are preserved, like Valve's).
#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Scalar(String),
    Object(Vec<(String, Node)>),
}

impl Node {
    /// Case-insensitive lookup of a child key. Returns the first match.
    pub fn get(&self, key: &str) -> Option<&Node> {
        match self {
            Node::Object(pairs) => pairs
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
                .map(|(_, v)| v),
            Node::Scalar(_) => None,
        }
    }

    /// The string value if this node is a scalar.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Node::Scalar(s) => Some(s),
            Node::Object(_) => None,
        }
    }

    /// The child pairs if this node is an object.
    pub fn as_object(&self) -> Option<&Vec<(String, Node)>> {
        match self {
            Node::Object(pairs) => Some(pairs),
            Node::Scalar(_) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParseError {
    pub message: String,
    pub position: usize,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "VDF parse error at byte {}: {}",
            self.position, self.message
        )
    }
}

impl std::error::Error for ParseError {}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(text: &'a str) -> Self {
        Parser {
            bytes: text.as_bytes(),
            pos: 0,
        }
    }

    fn error(&self, message: &str) -> ParseError {
        ParseError {
            message: message.to_string(),
            position: self.pos,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    /// Skip whitespace and `//` line comments.
    fn skip_trivia(&mut self) {
        loop {
            while matches!(self.peek(), Some(b) if b.is_ascii_whitespace()) {
                self.pos += 1;
            }
            if self.peek() == Some(b'/') && self.bytes.get(self.pos + 1) == Some(&b'/') {
                while matches!(self.peek(), Some(b) if b != b'\n') {
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    /// Read one token: a quoted string, a bare (unquoted) string, `{` or `}`.
    fn next_token(&mut self) -> Result<Option<Token>, ParseError> {
        self.skip_trivia();
        match self.peek() {
            None => Ok(None),
            Some(b'{') => {
                self.pos += 1;
                Ok(Some(Token::OpenBrace))
            }
            Some(b'}') => {
                self.pos += 1;
                Ok(Some(Token::CloseBrace))
            }
            Some(b'"') => Ok(Some(Token::Text(self.read_quoted()?))),
            Some(_) => Ok(Some(Token::Text(self.read_bare()))),
        }
    }

    fn read_quoted(&mut self) -> Result<String, ParseError> {
        // Assumes current byte is the opening quote.
        self.pos += 1;
        let mut out = String::new();
        loop {
            match self.peek() {
                None => return Err(self.error("unterminated quoted string")),
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    let next = self.bytes.get(self.pos + 1).copied();
                    match next {
                        Some(b'"') => {
                            out.push('"');
                            self.pos += 2;
                        }
                        Some(b'\\') => {
                            out.push('\\');
                            self.pos += 2;
                        }
                        Some(b'n') => {
                            out.push('\n');
                            self.pos += 2;
                        }
                        Some(b't') => {
                            out.push('\t');
                            self.pos += 2;
                        }
                        // Unknown escape: keep the escaped char literally.
                        Some(other) => {
                            out.push(other as char);
                            self.pos += 2;
                        }
                        None => return Err(self.error("unterminated escape sequence")),
                    }
                }
                Some(_) => {
                    // Consume one full UTF-8 char.
                    let s = &self.bytes[self.pos..];
                    let s = std::str::from_utf8(s)
                        .map_err(|_| self.error("invalid UTF-8 in string"))?;
                    let ch = s.chars().next().unwrap();
                    out.push(ch);
                    self.pos += ch.len_utf8();
                }
            }
        }
    }

    fn read_bare(&mut self) -> String {
        let start = self.pos;
        while matches!(self.peek(), Some(b) if !b.is_ascii_whitespace() && b != b'{' && b != b'}') {
            self.pos += 1;
        }
        String::from_utf8_lossy(&self.bytes[start..self.pos]).into_owned()
    }

    /// Parse a sequence of key-value pairs until `}` or end of input.
    /// Returns (pairs, closed_by_brace).
    fn parse_pairs(&mut self) -> Result<(Vec<(String, Node)>, bool), ParseError> {
        let mut pairs = Vec::new();
        loop {
            match self.next_token()? {
                None => return Ok((pairs, false)),
                Some(Token::CloseBrace) => return Ok((pairs, true)),
                Some(Token::OpenBrace) => {
                    return Err(self.error("unexpected '{' where a key was expected"));
                }
                Some(Token::Text(key)) => {
                    // Conditional tags like [$WIN32] may follow a pair in real
                    // files; appmanifest/libraryfolders don't use them, and a
                    // bracketed token is consumed as the *value* if it appears
                    // here — acceptable for our two file types.
                    match self.next_token()? {
                        Some(Token::OpenBrace) => {
                            let (children, closed) = self.parse_pairs()?;
                            if !closed {
                                return Err(self.error("unterminated object"));
                            }
                            pairs.push((key, Node::Object(children)));
                        }
                        Some(Token::Text(value)) => {
                            pairs.push((key, Node::Scalar(value)));
                        }
                        Some(Token::CloseBrace) => {
                            return Err(self.error("missing value for key"));
                        }
                        None => return Err(self.error("missing value for key")),
                    }
                }
            }
        }
    }
}

enum Token {
    OpenBrace,
    CloseBrace,
    Text(String),
}

/// Parse a whole VDF/ACF document. The result is a synthetic root object
/// holding the document's top-level pairs.
pub fn parse(text: &str) -> Result<Node, ParseError> {
    let mut parser = Parser::new(text);
    let (pairs, closed) = parser.parse_pairs()?;
    if closed {
        return Err(parser.error("unexpected '}' at top level"));
    }
    Ok(Node::Object(pairs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_objects_and_scalars() {
        let node = parse(
            r#"
            "AppState"
            {
                "appid"  "730"
                "name"   "Counter-Strike 2"
                "UserConfig"
                {
                    "language" "english"
                }
            }
            "#,
        )
        .unwrap();
        let app = node.get("appstate").unwrap();
        assert_eq!(app.get("APPID").unwrap().as_str(), Some("730"));
        assert_eq!(app.get("name").unwrap().as_str(), Some("Counter-Strike 2"));
        assert_eq!(
            app.get("UserConfig")
                .unwrap()
                .get("language")
                .unwrap()
                .as_str(),
            Some("english")
        );
    }

    #[test]
    fn skips_comments() {
        let node = parse("// hello\n\"a\" \"b\" // trailing\n\"c\" \"d\"").unwrap();
        assert_eq!(node.get("a").unwrap().as_str(), Some("b"));
        assert_eq!(node.get("c").unwrap().as_str(), Some("d"));
    }

    #[test]
    fn unescapes_windows_paths() {
        let node = parse(r#""path" "C:\\Program Files (x86)\\Steam""#).unwrap();
        assert_eq!(
            node.get("path").unwrap().as_str(),
            Some("C:\\Program Files (x86)\\Steam")
        );
    }

    #[test]
    fn accepts_bare_unquoted_tokens() {
        let node = parse("a b\nc { d e }").unwrap();
        assert_eq!(node.get("a").unwrap().as_str(), Some("b"));
        assert_eq!(node.get("c").unwrap().get("d").unwrap().as_str(), Some("e"));
    }

    #[test]
    fn rejects_unterminated_object() {
        assert!(parse("\"a\" { \"b\" \"c\"").is_err());
    }

    #[test]
    fn rejects_unterminated_string() {
        assert!(parse("\"a\" \"b").is_err());
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse("}").is_err());
        assert!(parse("\"onlykey\"").is_err());
    }
}
