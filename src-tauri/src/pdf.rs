use comrak::nodes::{AstNode, NodeValue};
use comrak::{parse_document, Arena, Options};
use genpdf::elements::{Break, OrderedList, Paragraph, TableLayout, UnorderedList};
use genpdf::fonts::{FontData, FontFamily};
use genpdf::style::{self, Style};
use genpdf::{Document, Element, SimplePageDecorator};

static SANS_REGULAR: &[u8] = include_bytes!("../fonts/LiberationSans-Regular.ttf");
static SANS_BOLD: &[u8] = include_bytes!("../fonts/LiberationSans-Bold.ttf");
static SANS_ITALIC: &[u8] = include_bytes!("../fonts/LiberationSans-Italic.ttf");
static SANS_BOLD_ITALIC: &[u8] = include_bytes!("../fonts/LiberationSans-BoldItalic.ttf");
static MONO_REGULAR: &[u8] = include_bytes!("../fonts/LiberationMono-Regular.ttf");

const HEADING_SIZES: [u8; 6] = [20, 17, 14, 12, 11, 10];
const BODY_SIZE: u8 = 10;
const CODE_SIZE: u8 = 9;

/// Inline style context carried while walking the AST.
#[derive(Clone, Default)]
struct InlineCtx {
    bold: bool,
    italic: bool,
    code: bool,
    link_url: Option<String>,
}

pub fn generate_pdf(title: &str, markdown: &str, output_path: &str) -> Result<(), String> {
    let body_family = FontFamily {
        regular: FontData::new(SANS_REGULAR.to_vec(), None).map_err(|e| e.to_string())?,
        bold: FontData::new(SANS_BOLD.to_vec(), None).map_err(|e| e.to_string())?,
        italic: FontData::new(SANS_ITALIC.to_vec(), None).map_err(|e| e.to_string())?,
        bold_italic: FontData::new(SANS_BOLD_ITALIC.to_vec(), None).map_err(|e| e.to_string())?,
    };

    let mono_data = FontData::new(MONO_REGULAR.to_vec(), None).map_err(|e| e.to_string())?;

    let mut doc = Document::new(body_family);
    doc.set_title(title);

    let mono_family = doc.add_font_family(FontFamily {
        regular: mono_data.clone(),
        bold: mono_data.clone(),
        italic: mono_data.clone(),
        bold_italic: mono_data,
    });

    let mut decorator = SimplePageDecorator::new();
    decorator.set_margins(20);
    doc.set_page_decorator(decorator);

    // Render title
    let title_style = Style::new().bold().with_font_size(HEADING_SIZES[0]);
    let mut title_para = Paragraph::default();
    title_para.push_styled(title, title_style);
    doc.push(title_para);
    doc.push(Break::new(1));

    // Parse markdown
    let arena = Arena::new();
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.tasklist = true;
    options.extension.strikethrough = true;

    let root = parse_document(&arena, markdown, &options);

    for child in root.children() {
        render_node(&mut doc, child, &InlineCtx::default(), mono_family);
    }

    doc.render_to_file(output_path)
        .map_err(|e| format!("Failed to write PDF: {}", e))
}

fn render_node<'a>(
    doc: &mut Document,
    node: &'a AstNode<'a>,
    ctx: &InlineCtx,
    mono_font: genpdf::fonts::FontFamily<genpdf::fonts::Font>,
) {
    let val = &node.data.borrow().value;
    match val {
        NodeValue::Heading(heading) => {
            let level = heading.level.min(6).max(1) as usize;
            let size = HEADING_SIZES[level - 1];
            let mut para = Paragraph::default();
            let heading_ctx = InlineCtx { bold: true, ..ctx.clone() };
            collect_inline_spans(&mut para, node, &heading_ctx, mono_font, size);
            let heading_style = Style::new().with_font_size(size);
            doc.push(para.styled(heading_style));
            doc.push(Break::new(0.3));
        }
        NodeValue::Paragraph => {
            if is_inside_list_item(node) && is_first_child(node) {
                return;
            }
            let mut para = Paragraph::default();
            collect_inline_spans(&mut para, node, ctx, mono_font, BODY_SIZE);
            doc.push(para);
            doc.push(Break::new(0.3));
        }
        NodeValue::CodeBlock(cb) => {
            let mono_style = Style::from(mono_font).with_font_size(CODE_SIZE);
            for line in cb.literal.lines() {
                let mut para = Paragraph::default();
                para.push_styled(format!("    {}", line), mono_style);
                doc.push(para);
            }
            doc.push(Break::new(0.3));
        }
        NodeValue::BlockQuote => {
            for child in node.children() {
                let bq_ctx = InlineCtx { italic: true, ..ctx.clone() };
                let mut para = Paragraph::default();
                para.push_styled(
                    "  \u{201C} ",
                    Style::new().italic().with_font_size(BODY_SIZE),
                );
                collect_inline_spans(&mut para, child, &bq_ctx, mono_font, BODY_SIZE);
                doc.push(para);
            }
            doc.push(Break::new(0.3));
        }
        NodeValue::List(list) => {
            if list.list_type == comrak::nodes::ListType::Ordered {
                let mut ol = OrderedList::new();
                for item in node.children() {
                    let para = build_list_item_paragraph(item, ctx, mono_font);
                    ol.push(para);
                }
                doc.push(ol);
            } else {
                let mut ul = UnorderedList::new();
                for item in node.children() {
                    if let NodeValue::TaskItem(checked) = &item.data.borrow().value {
                        let prefix = if checked.is_some() {
                            "\u{2611} "
                        } else {
                            "\u{2610} "
                        };
                        let mut para = Paragraph::default();
                        para.push(prefix);
                        collect_inline_from_item(&mut para, item, ctx, mono_font, BODY_SIZE);
                        ul.push(para);
                    } else {
                        let para = build_list_item_paragraph(item, ctx, mono_font);
                        ul.push(para);
                    }
                }
                doc.push(ul);
            }
            doc.push(Break::new(0.3));
        }
        NodeValue::Table(..) => {
            render_table(doc, node, ctx, mono_font);
            doc.push(Break::new(0.3));
        }
        NodeValue::ThematicBreak => {
            doc.push(Paragraph::new(
                "\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}",
            ));
            doc.push(Break::new(0.3));
        }
        NodeValue::SoftBreak | NodeValue::LineBreak => {}
        _ => {
            for child in node.children() {
                render_node(doc, child, ctx, mono_font);
            }
        }
    }
}

fn is_inside_list_item<'a>(node: &'a AstNode<'a>) -> bool {
    if let Some(parent) = node.parent() {
        matches!(
            parent.data.borrow().value,
            NodeValue::Item(..) | NodeValue::TaskItem(..)
        )
    } else {
        false
    }
}

fn is_first_child<'a>(node: &'a AstNode<'a>) -> bool {
    if let Some(parent) = node.parent() {
        if let Some(first) = parent.first_child() {
            return std::ptr::eq(first, node);
        }
    }
    false
}

fn collect_inline_spans<'a>(
    para: &mut Paragraph,
    node: &'a AstNode<'a>,
    ctx: &InlineCtx,
    mono_font: genpdf::fonts::FontFamily<genpdf::fonts::Font>,
    font_size: u8,
) {
    for child in node.children() {
        push_inline(para, child, ctx, mono_font, font_size);
    }
}

fn push_inline<'a>(
    para: &mut Paragraph,
    node: &'a AstNode<'a>,
    ctx: &InlineCtx,
    mono_font: genpdf::fonts::FontFamily<genpdf::fonts::Font>,
    font_size: u8,
) {
    let val = &node.data.borrow().value;
    match val {
        NodeValue::Text(text) => {
            let styled = build_inline_style(ctx, mono_font, font_size);
            if let Some(url) = &ctx.link_url {
                para.push_styled(format!("{} ({})", text, url), styled);
            } else {
                para.push_styled(text.clone(), styled);
            }
        }
        NodeValue::Code(code) => {
            let code_ctx = InlineCtx { code: true, ..ctx.clone() };
            let styled = build_inline_style(&code_ctx, mono_font, font_size);
            para.push_styled(code.literal.clone(), styled);
        }
        NodeValue::Strong => {
            let new_ctx = InlineCtx { bold: true, ..ctx.clone() };
            for child in node.children() {
                push_inline(para, child, &new_ctx, mono_font, font_size);
            }
        }
        NodeValue::Emph => {
            let new_ctx = InlineCtx { italic: true, ..ctx.clone() };
            for child in node.children() {
                push_inline(para, child, &new_ctx, mono_font, font_size);
            }
        }
        NodeValue::Strikethrough => {
            // genpdf has no strikethrough; wrap text with tildes
            para.push("~");
            for child in node.children() {
                push_inline(para, child, ctx, mono_font, font_size);
            }
            para.push("~");
        }
        NodeValue::Link(link) => {
            let new_ctx = InlineCtx {
                link_url: Some(link.url.clone()),
                ..ctx.clone()
            };
            for child in node.children() {
                push_inline(para, child, &new_ctx, mono_font, font_size);
            }
        }
        NodeValue::SoftBreak => {
            para.push(" ");
        }
        NodeValue::LineBreak => {
            para.push("\n");
        }
        NodeValue::Paragraph => {
            for child in node.children() {
                push_inline(para, child, ctx, mono_font, font_size);
            }
        }
        _ => {
            for child in node.children() {
                push_inline(para, child, ctx, mono_font, font_size);
            }
        }
    }
}

fn build_inline_style(ctx: &InlineCtx, mono_font: genpdf::fonts::FontFamily<genpdf::fonts::Font>, font_size: u8) -> Style {
    let mut s = if ctx.code {
        Style::from(mono_font).with_font_size(CODE_SIZE)
    } else {
        Style::new().with_font_size(font_size)
    };
    if ctx.bold {
        s = s.bold();
    }
    if ctx.italic {
        s = s.italic();
    }
    if ctx.link_url.is_some() {
        s = s.with_color(style::Color::Rgb(0, 0, 200));
    }
    s
}

fn build_list_item_paragraph<'a>(
    item: &'a AstNode<'a>,
    ctx: &InlineCtx,
    mono_font: genpdf::fonts::FontFamily<genpdf::fonts::Font>,
) -> Paragraph {
    let mut para = Paragraph::default();
    collect_inline_from_item(&mut para, item, ctx, mono_font, BODY_SIZE);
    para
}

fn collect_inline_from_item<'a>(
    para: &mut Paragraph,
    item: &'a AstNode<'a>,
    ctx: &InlineCtx,
    mono_font: genpdf::fonts::FontFamily<genpdf::fonts::Font>,
    font_size: u8,
) {
    for child in item.children() {
        let val = &child.data.borrow().value;
        match val {
            NodeValue::Paragraph => {
                collect_inline_spans(para, child, ctx, mono_font, font_size);
            }
            _ => {
                push_inline(para, child, ctx, mono_font, font_size);
            }
        }
    }
}

fn render_table<'a>(
    doc: &mut Document,
    node: &'a AstNode<'a>,
    ctx: &InlineCtx,
    mono_font: genpdf::fonts::FontFamily<genpdf::fonts::Font>,
) {
    let first_row = node.children().next();
    let num_cols = first_row.map(|r| r.children().count()).unwrap_or(0);
    if num_cols == 0 {
        return;
    }

    let col_weights: Vec<usize> = vec![1; num_cols];
    let mut table = TableLayout::new(col_weights);
    table.set_cell_decorator(genpdf::elements::FrameCellDecorator::new(true, true, false));

    for row_node in node.children() {
        let is_header = matches!(row_node.data.borrow().value, NodeValue::TableRow(true));
        let mut row = table.row();
        for cell_node in row_node.children() {
            let mut para = Paragraph::default();
            let cell_ctx = if is_header {
                InlineCtx { bold: true, ..ctx.clone() }
            } else {
                ctx.clone()
            };
            collect_inline_spans(&mut para, cell_node, &cell_ctx, mono_font, BODY_SIZE);
            row.push_element(para);
        }
        let _ = row.push();
    }

    doc.push(table);
}
