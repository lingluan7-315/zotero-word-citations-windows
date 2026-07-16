# Zotero Word Citations for Windows

Windows skill for inserting live Zotero citations and bibliographies into Microsoft Word.

# Windows 版 Zotero Word 动态引文工具

用于在 Windows Word 中插入 Zotero 动态引文和参考文献，支持连续多文献合并、稳定对话框处理和 Word 进程安全管理。

## Features / 功能

- Insert live Zotero citation fields instead of static text. / 插入 Zotero 动态引文域，而不是静态文本。
- Group multiple references in one citation dialog and one field. / 在同一次对话中合并多个连续参考文献。
- Place citations immediately after the supporting claim. / 将引文放在对应论断之后的合适位置。
- Avoid closing Word instances opened manually by the user. / 避免关闭用户手动打开的 Word 进程。
- Provide a local bridge for reliable Zotero Word integration. / 提供用于稳定集成 Zotero 与 Word 的本地桥接。

## Requirements / 使用要求

- Windows
- Microsoft Word desktop
- Zotero Desktop with the Word integration add-in enabled
- Python 3.9 or newer

## Example / 示例

```powershell
python scripts/zotero_word_windows.py check
python scripts/zotero_word_windows.py insert --docx "E:\\Temp\\paper.docx" --item-keys KEY1 KEY2 KEY3 --style Myself --marker "{{CITATION_GROUP_1}}" --save --close
```

The `--item-keys` option inserts consecutive references into one Zotero citation field. Do not insert separate fields and join them manually with semicolons.

`--close` only closes a Word instance created by the helper. A Word instance already opened by the user is never force-closed.

## License / 许可证

MIT License
