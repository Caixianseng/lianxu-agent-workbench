using System;
using System.Text;
using System.IO;
using System.Windows.Forms;
using System.Web.Script.Serialization;

internal static class NativePicker
{
    [STAThread]
    private static int Main()
    {
        try
        {
            Application.EnableVisualStyles();
            object selection = new { cancelled = true };
            using (var owner = new Form())
            using (var dialog = new OpenFileDialog())
            {
                owner.Text = "联序 · 本机文件选择";
                owner.Width = 400;
                owner.Height = 110;
                owner.FormBorderStyle = FormBorderStyle.FixedDialog;
                owner.MinimizeBox = false;
                owner.MaximizeBox = false;
                owner.StartPosition = FormStartPosition.CenterScreen;
                owner.TopMost = true;
                owner.Controls.Add(new Label { Text = "请在文件窗口中选择 Agent 程序或模型清单。", Dock = DockStyle.Fill, TextAlign = System.Drawing.ContentAlignment.MiddleCenter });
                dialog.Title = "联序 · 选择本地 Agent";
                dialog.Filter = "Agent 程序或模型清单 (*.exe;*.json)|*.exe;*.json|所有文件 (*.*)|*.*";
                dialog.InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                dialog.CheckFileExists = true;
                dialog.Multiselect = false;
                dialog.RestoreDirectory = true;
                // Display after the owner has entered its UI message loop. A naked
                // ShowDialog call from a background host can hang before rendering.
                owner.Shown += delegate {
                    owner.BeginInvoke(new Action(delegate {
                        try {
                            var result = dialog.ShowDialog(owner);
                            if (result == DialogResult.OK) selection = new { path = dialog.FileName };
                        } finally { owner.Close(); }
                    }));
                };
                Application.Run(owner);
            }
            // A WinExe has no console. Write directly to the inherited pipe;
            // setting Console.OutputEncoding can fail with an invalid handle.
            using (var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)))
            {
                output.WriteLine(new JavaScriptSerializer().Serialize(selection));
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name);
            return 1;
        }
    }
}
