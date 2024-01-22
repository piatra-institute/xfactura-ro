import Tooltip from '../Tooltip';



export default function TooltipQuestion({
    content,
}: {
    content: React.ReactNode;
}) {
    return (
        <Tooltip
            content={(
                <div
                    className="max-w-[250px] p-2"
                >
                    {content}
                </div>
            )}
        >
            <span
                className="text-gray-400 cursor-pointer"
            >
                ?
            </span>
        </Tooltip>
    );
}
